/**
 * prove-bench.mjs — Veil circuit benchmark: constraint counts, proving time, artifact sizes.
 *
 * Measures real Groth16 proving (snarkjs fullProve) for transfer/compliance/withdraw against
 * the compiled artifacts in circuits/build (and build-compliance, build-withdraw), using the
 * same witness shapes as circuits/test/ *.test.mjs. Every number printed comes from a timed
 * run in this process — nothing here is estimated.
 *
 * Requires: circuits/build (transfer), circuits/build-compliance, circuits/build-withdraw
 * to already contain <name>_js/<name>.wasm, <name>_final.zkey, <name>_vk.json.
 * Produce them with: cd circuits && npx circom2 <name>.circom --r1cs --wasm --sym --output build
 * followed by snarkjs groth16 setup + zkey contribute + zkey export verificationkey
 * (see docs/research/2026-07-18-baseline-measurement.md for the exact commands run).
 *
 * Usage: node scripts/bench/prove-bench.mjs [--runs N]
 */

import { existsSync, readFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CIRCUITS_DIR = join(REPO_ROOT, "circuits");

const { groth16 } = await import(
  pathToFileURL(join(CIRCUITS_DIR, "node_modules", "snarkjs", "build", "main.cjs")).href
);
const { buildPoseidon } = await import(
  pathToFileURL(join(CIRCUITS_DIR, "node_modules", "circomlibjs", "build", "main.cjs")).href
);

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 5;
})();

function toBI(poseidonF, val) {
  if (typeof val === "bigint") return val;
  if (val instanceof Uint8Array) return poseidonF.toObject(val);
  return BigInt(val);
}

function toStringInputs(inputs) {
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  return out;
}

// ── Witness builders (mirrors circuits/test/*.test.mjs buildValidWitness) ──────────

function buildTransferWitness(poseidon, F) {
  const DOMAIN_COMMITMENT = 1n, DOMAIN_NULLIFIER = 2n, DOMAIN_TX_AMOUNT = 3n, MERKLE_DEPTH = 20;
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = toBI(F, poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(F, poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(F, poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const txAmountHash = toBI(F, poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  let node = oldCommitment;
  for (let i = 0; i < MERKLE_DEPTH; i++) node = toBI(F, poseidon([node, pathElements[i]]));
  const merkleRoot = node;
  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

function buildComplianceWitness(poseidon, F) {
  const DOMAIN_CREDENTIAL_LEAF = 4n, DOMAIN_COMPLIANCE_NULLIFIER = 5n, DOMAIN_CONTEXT_BINDING = 6n, MERKLE_DEPTH = 20;
  const userSecret = 987654321n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 42n;
  const currentEpoch = 500n, requiredKycLevel = 1n, transferNullifier = 111222333n;
  const credentialLeaf = toBI(F, poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));
  const pathElements = [], pathIndices = [];
  let current = credentialLeaf, zeroHash = 0n;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    pathElements.push(zeroHash);
    pathIndices.push(0n);
    current = toBI(F, poseidon([current, zeroHash]));
    zeroHash = toBI(F, poseidon([zeroHash, zeroHash]));
  }
  const merkleRoot = current;
  const contextId = toBI(F, poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]));
  const nullifier = toBI(F, poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]));
  const expiryValid = expiryEpoch >= currentEpoch ? 1n : 0n;
  const kycValid = kycLevel >= requiredKycLevel ? 1n : 0n;
  const validCredential = expiryValid * kycValid;
  return {
    merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
  };
}

function buildWithdrawWitness(poseidon, F) {
  const DOMAIN_COMMITMENT = 1n, DOMAIN_WITHDRAW_NULLIFIER = 7n, DOMAIN_RECIPIENT_HASH = 8n;
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xabcdef123456n, randomnessNew = 77777n;
  const commitment = toBI(F, poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = toBI(F, poseidon([DOMAIN_COMMITMENT, remainingBalance, randomnessNew, userSecret]));
  const nullifier = toBI(F, poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));
  const recipientHash = toBI(F, poseidon([DOMAIN_RECIPIENT_HASH, recipient]));
  return {
    commitment, withdrawAmount, nullifier, recipientHash, newCommitment,
    cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew,
  };
}

const CIRCUITS = [
  { name: "transfer", buildDir: join(CIRCUITS_DIR, "build"), build: buildTransferWitness },
  { name: "compliance", buildDir: join(CIRCUITS_DIR, "build-compliance"), build: buildComplianceWitness },
  { name: "withdraw", buildDir: join(CIRCUITS_DIR, "build-withdraw"), build: buildWithdrawWitness },
];

async function benchCircuit(poseidon, F, spec) {
  const wasmPath = join(spec.buildDir, `${spec.name}_js`, `${spec.name}.wasm`);
  const zkeyPath = join(spec.buildDir, `${spec.name}_final.zkey`);
  const vkPath = join(spec.buildDir, `${spec.name}_vk.json`);
  const r1csPath = join(spec.buildDir, `${spec.name}.r1cs`);

  if (!existsSync(wasmPath) || !existsSync(zkeyPath) || !existsSync(vkPath)) {
    return { name: spec.name, error: `missing artifacts in ${spec.buildDir}` };
  }

  const vk = JSON.parse(readFileSync(vkPath, "utf8"));
  const witness = spec.build(poseidon, F);
  const stringInputs = toStringInputs(witness);

  const proveTimesMs = [];
  let lastProof, lastPublicSignals, verifyOk;
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    const { proof, publicSignals } = await groth16.fullProve(stringInputs, wasmPath, zkeyPath);
    const t1 = process.hrtime.bigint();
    proveTimesMs.push(Number(t1 - t0) / 1e6);
    lastProof = proof;
    lastPublicSignals = publicSignals;
  }
  verifyOk = await groth16.verify(vk, lastPublicSignals, lastProof);

  const proofBytes = Buffer.byteLength(JSON.stringify(lastProof), "utf8");
  const vkBytes = statSync(vkPath).size;
  const zkeyBytes = statSync(zkeyPath).size;
  const wasmBytes = statSync(wasmPath).size;

  return {
    name: spec.name,
    runs: RUNS,
    proveTimesMs,
    proveTimeMeanMs: proveTimesMs.reduce((a, b) => a + b, 0) / proveTimesMs.length,
    proveTimeMinMs: Math.min(...proveTimesMs),
    proveTimeMaxMs: Math.max(...proveTimesMs),
    verifyOk,
    proofBytes,
    vkBytes,
    zkeyBytes,
    wasmBytes,
    r1csExists: existsSync(r1csPath),
  };
}

const poseidon = await buildPoseidon();
const F = poseidon.F;

const results = [];
for (const spec of CIRCUITS) {
  process.stderr.write(`benchmarking ${spec.name} (${RUNS} runs)...\n`);
  const r = await benchCircuit(poseidon, F, spec);
  results.push(r);
  if (r.error) {
    process.stderr.write(`  SKIPPED: ${r.error}\n`);
  } else {
    process.stderr.write(
      `  mean=${r.proveTimeMeanMs.toFixed(1)}ms min=${r.proveTimeMinMs.toFixed(1)}ms max=${r.proveTimeMaxMs.toFixed(1)}ms ` +
      `proof=${r.proofBytes}B vk=${r.vkBytes}B zkey=${r.zkeyBytes}B wasm=${r.wasmBytes}B verify=${r.verifyOk}\n`
    );
  }
}

console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, runs: RUNS, results }, null, 2));

const anyError = results.some((r) => r.error);
process.exit(anyError ? 1 : 0);
