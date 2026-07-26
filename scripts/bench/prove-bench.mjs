/**
 * prove-bench.mjs — Veil circuit baseline benchmark
 *
 * Measures, on compiled build artifacts in circuits/build/, for each of the
 * three circuits (transfer, compliance, withdraw):
 *   - R1CS constraint count (from snarkjs r1cs info)
 *   - witness-generation time (wasm calculator)
 *   - Groth16 proving time (snarkjs groth16.prove on the precomputed witness)
 *   - Groth16 verification time
 *   - proof size (bytes, JSON-serialized) and verification-key size (bytes)
 *
 * All timings are wall-clock (performance.now()), N_TRIALS repetitions per
 * circuit after N_WARMUP discarded warmup runs, run serially on whatever
 * machine invokes this script — these are not hardware-independent numbers.
 *
 * Prerequisite: circuits/build/{name}.r1cs, {name}_js/{name}.wasm,
 * {name}_final.zkey, {name}_vk.json for each circuit. Build them with:
 *   cd circuits && npx circom2 <name>.circom --r1cs --wasm --sym -o build -l node_modules
 *   npx snarkjs groth16 setup build/<name>.r1cs build/pot15_final.ptau build/<name>_0000.zkey
 *   npx snarkjs zkey contribute build/<name>_0000.zkey build/<name>_final.zkey --name=x -v
 *   npx snarkjs zkey export verificationkey build/<name>_final.zkey build/<name>_vk.json
 *
 * Usage: node scripts/bench/prove-bench.mjs [--trials=N] [--warmup=N] [--circuit=transfer|compliance|withdraw]
 *
 * NOTE: running all three circuits back-to-back in a single process has been observed to hang
 * (no forward progress, 0% further CPU use) on at least one run in this environment, cause
 * unconfirmed (isolated per-circuit repros of the same code path did not reproduce it). Prefer
 * invoking with --circuit=<name> as three separate process runs, which reliably completes; the
 * no-argument all-circuits path is kept for convenience on environments where it isn't triggered.
 */

import { buildPoseidon } from "circomlibjs";
import { existsSync, readFileSync, statSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const BUILD_DIR = join(CIRCUITS_DIR, "build");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);
const N_TRIALS = Number(args.trials ?? 10);
const N_WARMUP = Number(args.warmup ?? 2);
const ONLY_CIRCUIT = typeof args.circuit === "string" ? args.circuit : null;

let poseidonF = null;
function toBI(val) {
  if (typeof val === "bigint") return val;
  if (poseidonF && val instanceof Uint8Array) return poseidonF.toObject(val);
  return BigInt(val);
}

function buildMerkleTree(poseidon, leaf, depth, pairHash = (a, b) => poseidon([a, b])) {
  const pathElements = [];
  const pathIndices = [];
  let current = leaf;
  let zeroHash = 0n;
  for (let i = 0; i < depth; i++) {
    pathElements.push(zeroHash);
    pathIndices.push(0n);
    current = toBI(pairHash(current, zeroHash));
    zeroHash = toBI(pairHash(zeroHash, zeroHash));
  }
  return { root: current, pathElements, pathIndices };
}

// ── Witness builders (mirrors circuits/test/*.test.mjs buildValidWitness) ───

function buildTransferWitness(poseidon) {
  const DOMAIN_COMMITMENT = 1n, DOMAIN_NULLIFIER = 2n, DOMAIN_TX_AMOUNT = 3n, MERKLE_DEPTH = 20;
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
  const { root: merkleRoot, pathElements, pathIndices } = buildMerkleTree(poseidon, oldCommitment, MERKLE_DEPTH);
  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

function buildComplianceWitness(poseidon) {
  const DOMAIN_CREDENTIAL_LEAF = 4n, DOMAIN_COMPLIANCE_NULLIFIER = 5n, DOMAIN_CONTEXT_BINDING = 6n, MERKLE_DEPTH = 20;
  const userSecret = 987654321n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 42n;
  const currentEpoch = 500n, requiredKycLevel = 1n, transferNullifier = 111222333n;
  const credentialLeaf = toBI(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));
  const { root: merkleRoot, pathElements, pathIndices } = buildMerkleTree(poseidon, credentialLeaf, MERKLE_DEPTH);
  const contextId = toBI(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]));
  const expiryValid = expiryEpoch >= currentEpoch ? 1n : 0n;
  const kycValid = kycLevel >= requiredKycLevel ? 1n : 0n;
  const validCredential = expiryValid * kycValid;
  return {
    merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
  };
}

function buildWithdrawWitness(poseidon) {
  const DOMAIN_COMMITMENT = 1n, DOMAIN_WITHDRAW_NULLIFIER = 7n, DOMAIN_RECIPIENT_HASH = 8n;
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

const CIRCUITS = [
  { name: "transfer", build: buildTransferWitness },
  { name: "compliance", build: buildComplianceWitness },
  { name: "withdraw", build: buildWithdrawWitness },
];

function stringifyInputs(inputs) {
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  return out;
}

function stats(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  return { mean, median, min: sorted[0], max: sorted[sorted.length - 1] };
}

async function benchCircuit(poseidon, { name, build }) {
  const r1csPath = join(BUILD_DIR, `${name}.r1cs`);
  const wasmPath = join(BUILD_DIR, `${name}_js`, `${name}.wasm`);
  const zkeyPath = join(BUILD_DIR, `${name}_final.zkey`);
  const vkPath = join(BUILD_DIR, `${name}_vk.json`);

  for (const p of [r1csPath, wasmPath, zkeyPath, vkPath]) {
    if (!existsSync(p)) {
      return { name, blocked: `missing build artifact: ${p}` };
    }
  }

  const vk = JSON.parse(readFileSync(vkPath, "utf8"));
  const vkSizeBytes = statSync(vkPath).size;
  const witnessInput = stringifyInputs(build(poseidon));
  const scratchDir = mkdtempSync(join(tmpdir(), `veil-bench-${name}-`));
  const wtnsPath = join(scratchDir, `${name}.wtns`);

  const witnessTimesMs = [];
  const proveTimesMs = [];
  const verifyTimesMs = [];
  let proofSizeBytes = 0;
  let lastValid = false;

  const totalRuns = N_WARMUP + N_TRIALS;
  for (let i = 0; i < totalRuns; i++) {
    const isWarmup = i < N_WARMUP;

    const t0 = performance.now();
    await snarkjs.wtns.calculate(witnessInput, wasmPath, wtnsPath);
    const t1 = performance.now();

    const { proof, publicSignals } = await snarkjs.groth16.prove(zkeyPath, wtnsPath);
    const t2 = performance.now();

    const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
    const t3 = performance.now();

    if (!isWarmup) {
      witnessTimesMs.push(t1 - t0);
      proveTimesMs.push(t2 - t1);
      verifyTimesMs.push(t3 - t2);
      proofSizeBytes = Buffer.byteLength(JSON.stringify(proof), "utf8");
      lastValid = valid;
    }
  }

  rmSync(scratchDir, { recursive: true, force: true });

  return {
    name,
    valid: lastValid,
    trials: N_TRIALS,
    witnessMs: stats(witnessTimesMs),
    proveMs: stats(proveTimesMs),
    verifyMs: stats(verifyTimesMs),
    totalMs: stats(witnessTimesMs.map((w, i) => w + proveTimesMs[i] + verifyTimesMs[i])),
    proofSizeBytes,
    vkSizeBytes,
  };
}

function fmt(n) {
  return n.toFixed(2);
}

async function main() {
  console.log(`=== Veil Groth16 baseline bench (N_TRIALS=${N_TRIALS}, N_WARMUP=${N_WARMUP}) ===`);
  console.log(`Node: ${process.version}, platform: ${process.platform}/${process.arch}`);
  console.log("");

  const poseidon = await buildPoseidon();
  poseidonF = poseidon.F;

  const circuitsToRun = ONLY_CIRCUIT ? CIRCUITS.filter((c) => c.name === ONLY_CIRCUIT) : CIRCUITS;
  const results = [];
  for (const c of circuitsToRun) {
    process.stdout.write(`[bench] ${c.name} ... `);
    const r = await benchCircuit(poseidon, c);
    results.push(r);
    if (r.blocked) {
      console.log(`BLOCKED (${r.blocked})`);
      continue;
    }
    console.log(`done (valid=${r.valid})`);
  }

  console.log("");
  console.log("| Circuit | valid | witness ms (mean/median) | prove ms (mean/median) | verify ms (mean/median) | total ms (mean/median) | proof bytes | vk bytes |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    if (r.blocked) {
      console.log(`| ${r.name} | BLOCKED | ${r.blocked} | | | | | |`);
      continue;
    }
    console.log(
      `| ${r.name} | ${r.valid} | ${fmt(r.witnessMs.mean)}/${fmt(r.witnessMs.median)} | ${fmt(r.proveMs.mean)}/${fmt(r.proveMs.median)} | ${fmt(r.verifyMs.mean)}/${fmt(r.verifyMs.median)} | ${fmt(r.totalMs.mean)}/${fmt(r.totalMs.median)} | ${r.proofSizeBytes} | ${r.vkSizeBytes} |`
    );
  }

  console.log("");
  console.log("Raw JSON:");
  console.log(JSON.stringify(results, null, 2));

  // snarkjs/ffjavascript leave a lingering handle (worker-thread pool for the curve
  // backend) that keeps the event loop alive after all work is done — without this,
  // the process sits idle indefinitely instead of exiting. Observed hang, cause
  // unconfirmed; explicit exit is the workaround.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
