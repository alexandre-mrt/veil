#!/usr/bin/env node
/**
 * prove-bench.mjs — Veil circuit baseline benchmark.
 *
 * Measures, for each compiled circuit: R1CS constraint count, Groth16 proving
 * time (wall clock, N repeated fullProve calls with a fresh valid witness),
 * verification time, and on-disk artifact sizes (r1cs, wasm, zkey, proof, vk).
 *
 * Requires the circuits to already be compiled (bash scripts/compile.sh,
 * scripts/compile-withdraw.sh, scripts/compile-compliance.sh — circom 2.1.x
 * and snarkjs 0.7.x on PATH).
 *
 * Usage:
 *   node scripts/bench/prove-bench.mjs [--runs N]
 *
 * Run from the repo root. Prints one JSON object per circuit to stdout plus
 * a human-readable summary table.
 */

import { buildPoseidon } from "circomlibjs";
import { groth16 } from "snarkjs";
import { existsSync, statSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CIRCUITS_DIR = join(REPO_ROOT, "circuits");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 5;
})();

let poseidonF = null;
function toBI(val) {
  if (typeof val === "bigint") return val;
  if (poseidonF && val instanceof Uint8Array) return poseidonF.toObject(val);
  return BigInt(val);
}

const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n;
const DOMAIN_CONTEXT_BINDING = 6n;
const DOMAIN_WITHDRAW_NULLIFIER = 7n;
const DOMAIN_RECIPIENT_HASH = 8n;
const MERKLE_DEPTH = 20;

function merkleRootFromPath(poseidon, leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < pathElements.length; i++) {
    const sibling = pathElements[i];
    const [left, right] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = toBI(poseidon([left, right]));
  }
  return node;
}

function buildZeroTree(poseidon, leaf, depth) {
  const pathElements = [];
  const pathIndices = [];
  let zeroHash = 0n;
  for (let i = 0; i < depth; i++) {
    pathElements.push(zeroHash);
    pathIndices.push(0n);
    zeroHash = toBI(poseidon([zeroHash, zeroHash]));
  }
  const root = merkleRootFromPath(poseidon, leaf, pathElements, pathIndices);
  return { root, pathElements, pathIndices };
}

function buildTransferWitness(poseidon) {
  const cumulativeOld = 100n, txAmount = 50n, randomnessOld = 55n, randomnessNew = 66n;
  const userSecret = 444n, epochId = 1n, threshold = 1_000_000_000n, salt = 9n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
  const { root: merkleRoot, pathElements, pathIndices } = buildZeroTree(poseidon, oldCommitment, MERKLE_DEPTH);
  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

function buildWithdrawWitness(poseidon) {
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xabcdef123456n, randomnessNew = 77777n;
  const commitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, remainingBalance, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));
  const recipientHash = toBI(poseidon([DOMAIN_RECIPIENT_HASH, recipient]));
  return {
    commitment, withdrawAmount, nullifier, recipientHash, newCommitment,
    cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew,
  };
}

function buildComplianceWitness(poseidon) {
  const userSecret = 987654321n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 42n;
  const currentEpoch = 500n, requiredKycLevel = 1n, transferNullifier = 111222333n;
  const credentialLeaf = toBI(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));
  const { root: merkleRoot, pathElements, pathIndices } = buildZeroTree(poseidon, credentialLeaf, MERKLE_DEPTH);
  const contextId = toBI(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]));
  const validCredential = (expiryEpoch >= currentEpoch ? 1n : 0n) * (kycLevel >= requiredKycLevel ? 1n : 0n);
  return {
    merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
  };
}

const CIRCUITS = [
  {
    name: "transfer",
    r1cs: join(CIRCUITS_DIR, "build", "transfer.r1cs"),
    wasm: join(CIRCUITS_DIR, "build", "transfer_js", "transfer.wasm"),
    zkey: join(CIRCUITS_DIR, "build", "transfer_final.zkey"),
    vk: join(CIRCUITS_DIR, "build", "transfer_vk.json"),
    buildWitness: buildTransferWitness,
  },
  {
    name: "withdraw",
    r1cs: join(CIRCUITS_DIR, "build-withdraw", "withdraw.r1cs"),
    wasm: join(CIRCUITS_DIR, "build-withdraw", "withdraw_js", "withdraw.wasm"),
    zkey: join(CIRCUITS_DIR, "build-withdraw", "withdraw_final.zkey"),
    vk: join(CIRCUITS_DIR, "build-withdraw", "withdraw_vk.json"),
    buildWitness: buildWithdrawWitness,
  },
  {
    name: "compliance",
    r1cs: join(CIRCUITS_DIR, "build-compliance", "compliance.r1cs"),
    wasm: join(CIRCUITS_DIR, "build-compliance", "compliance_js", "compliance.wasm"),
    zkey: join(CIRCUITS_DIR, "build-compliance", "compliance_final.zkey"),
    vk: join(CIRCUITS_DIR, "build-compliance", "compliance_vk.json"),
    buildWitness: buildComplianceWitness,
  },
];

function fileSize(path) {
  return existsSync(path) ? statSync(path).size : null;
}

function fmtBytes(n) {
  if (n === null) return "MISSING";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function median(arr) { const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

async function benchCircuit(poseidon, circuit) {
  const missing = ["r1cs", "wasm", "zkey", "vk"].filter((k) => !existsSync(circuit[k]));
  if (missing.length) {
    return { name: circuit.name, blocked: true, missing };
  }

  const r1csInfo = execSync(`snarkjs r1cs info "${circuit.r1cs}"`, { encoding: "utf8" });
  const constraintMatch = r1csInfo.match(/# of Constraints:\s*(\d+)/);
  const constraints = constraintMatch ? parseInt(constraintMatch[1], 10) : null;

  const stringInputs = {};
  const witness = circuit.buildWitness(poseidon);
  for (const [k, v] of Object.entries(witness)) {
    stringInputs[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }

  const proveTimes = [];
  let lastProof, lastPublicSignals;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const { proof, publicSignals } = await groth16.fullProve(stringInputs, circuit.wasm, circuit.zkey);
    const t1 = performance.now();
    proveTimes.push(t1 - t0);
    lastProof = proof;
    lastPublicSignals = publicSignals;
  }

  const vk = JSON.parse(readFileSync(circuit.vk, "utf8"));
  const verifyTimes = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const ok = await groth16.verify(vk, lastPublicSignals, lastProof);
    const t1 = performance.now();
    if (!ok) throw new Error(`${circuit.name}: verification failed on bench witness`);
    verifyTimes.push(t1 - t0);
  }

  const proofJson = JSON.stringify(lastProof);

  return {
    name: circuit.name,
    blocked: false,
    constraints,
    r1csInfoRaw: r1csInfo.trim(),
    proveMsRuns: proveTimes.map((t) => Math.round(t)),
    proveMsMean: Math.round(mean(proveTimes)),
    proveMsMedian: Math.round(median(proveTimes)),
    verifyMsRuns: verifyTimes.map((t) => Math.round(t * 100) / 100),
    verifyMsMean: Math.round(mean(verifyTimes) * 100) / 100,
    sizes: {
      r1csBytes: fileSize(circuit.r1cs),
      wasmBytes: fileSize(circuit.wasm),
      zkeyBytes: fileSize(circuit.zkey),
      vkBytes: fileSize(circuit.vk),
      proofBytes: Buffer.byteLength(proofJson, "utf8"),
    },
  };
}

async function main() {
  console.log(`=== Veil circuit baseline benchmark (${RUNS} runs/circuit) ===`);
  console.log(`node ${process.version}, snarkjs groth16, circom ${execSync("circom --version", { encoding: "utf8" }).trim()}`);
  console.log("");

  const poseidon = await buildPoseidon();
  poseidonF = poseidon.F;

  const results = [];
  for (const circuit of CIRCUITS) {
    process.stdout.write(`--- ${circuit.name} ---\n`);
    const result = await benchCircuit(poseidon, circuit);
    if (result.blocked) {
      console.log(`  BLOCKED: missing artifacts [${result.missing.join(", ")}]. Compile first.`);
    } else {
      console.log(`  constraints:        ${result.constraints}`);
      console.log(`  prove (ms):         mean=${result.proveMsMean} median=${result.proveMsMedian} runs=${JSON.stringify(result.proveMsRuns)}`);
      console.log(`  verify (ms):        mean=${result.verifyMsMean} runs=${JSON.stringify(result.verifyMsRuns)}`);
      console.log(`  r1cs size:          ${fmtBytes(result.sizes.r1csBytes)}`);
      console.log(`  wasm size:          ${fmtBytes(result.sizes.wasmBytes)}`);
      console.log(`  zkey size:          ${fmtBytes(result.sizes.zkeyBytes)}`);
      console.log(`  vk size:            ${fmtBytes(result.sizes.vkBytes)}`);
      console.log(`  proof size (json):  ${fmtBytes(result.sizes.proofBytes)}`);
    }
    console.log("");
    results.push(result);
  }

  console.log("=== JSON ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
