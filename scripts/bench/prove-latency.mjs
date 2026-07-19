#!/usr/bin/env node
/**
 * scripts/bench/prove-latency.mjs — Veil circuit proving benchmark.
 *
 * Measures, per circuit (transfer / compliance / withdraw), real Groth16
 * witness-generation + proving + verification wall time, and proof / VK
 * artifact sizes, on THIS machine. No estimates: every number here comes
 * from `snarkjs.groth16.fullProve` / `snarkjs.groth16.verify` actually run.
 *
 * Witness construction mirrors circuits/test/{transfer,compliance,withdraw}.test.mjs
 * exactly (same domain tags, same Merkle-path convention) so a benchmark run
 * proves and verifies real, circuit-satisfying witnesses — not placeholders.
 *
 * Prereqs: circuits/build/<name>_js/<name>.wasm, <name>_final.zkey,
 * <name>_vk.json must exist. See docs/research/2026-07-19-baseline.md for
 * the exact commands that produced them in this run.
 *
 * Usage: cd circuits && node ../scripts/bench/prove-latency.mjs [--runs N]
 */
import { groth16 } from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const BUILD_DIR = join(CIRCUITS_DIR, "build");
const MERKLE_DEPTH = 20;

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx >= 0 ? Number(process.argv[idx + 1]) : 5;
})();

let poseidonF = null;
function toBI(val) {
  if (typeof val === "bigint") return val;
  if (poseidonF && val instanceof Uint8Array) return poseidonF.toObject(val);
  return BigInt(val);
}

// -- transfer.circom -- mirrors circuits/test/transfer.test.mjs buildValidWitness
function merkleRootFromPath(poseidon, leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    const sibling = pathElements[i];
    const [left, right] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = toBI(poseidon([left, right]));
  }
  return node;
}

function buildTransferInput(poseidon) {
  const DOMAIN_COMMITMENT = 1n, DOMAIN_NULLIFIER = 2n, DOMAIN_TX_AMOUNT = 3n;
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const merkleRoot = merkleRootFromPath(poseidon, oldCommitment, pathElements, pathIndices);
  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

// -- compliance.circom -- mirrors circuits/test/compliance.test.mjs buildValidWitness
function buildMerkleTree(poseidon, leaf, depth) {
  const pathElements = [];
  const pathIndices = [];
  let current = leaf;
  let zeroHash = 0n;
  for (let i = 0; i < depth; i++) {
    pathElements.push(zeroHash);
    pathIndices.push(0n);
    current = toBI(poseidon([current, zeroHash]));
    zeroHash = toBI(poseidon([zeroHash, zeroHash]));
  }
  return { root: current, pathElements, pathIndices };
}

function buildComplianceInput(poseidon) {
  const DOMAIN_CREDENTIAL_LEAF = 4n, DOMAIN_COMPLIANCE_NULLIFIER = 5n, DOMAIN_CONTEXT_BINDING = 6n;
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

// -- withdraw.circom -- mirrors circuits/test/withdraw.test.mjs buildValidWitness
function buildWithdrawInput(poseidon) {
  const DOMAIN_COMMITMENT = 1n, DOMAIN_WITHDRAW_NULLIFIER = 7n, DOMAIN_RECIPIENT_HASH = 8n;
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xABCDEF123456n, randomnessNew = 77777n;
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

const CIRCUITS = {
  transfer: buildTransferInput,
  compliance: buildComplianceInput,
  withdraw: buildWithdrawInput,
};

function fmtMs(ms) {
  return `${ms.toFixed(1)}ms`;
}

async function benchCircuit(name, buildInput) {
  const wasmPath = join(BUILD_DIR, `${name}_js`, `${name}.wasm`);
  const zkeyPath = join(BUILD_DIR, `${name}_final.zkey`);
  const vkPath = join(BUILD_DIR, `${name}_vk.json`);
  if (!existsSync(wasmPath) || !existsSync(zkeyPath) || !existsSync(vkPath)) {
    console.log(`[${name}] SKIP — missing build artifacts (wasm/zkey/vk)`);
    return null;
  }
  const vk = JSON.parse(readFileSync(vkPath, "utf8"));
  const zkeySize = statSync(zkeyPath).size;
  const wasmSize = statSync(wasmPath).size;

  const poseidon = await buildPoseidon();
  poseidonF = poseidon.F;

  const proveTimes = [];
  const verifyTimes = [];
  let lastProof = null;

  for (let i = 0; i < RUNS; i++) {
    const input = buildInput(poseidon);
    const t0 = performance.now();
    const { proof, publicSignals } = await groth16.fullProve(input, wasmPath, zkeyPath);
    const t1 = performance.now();
    const ok = await groth16.verify(vk, publicSignals, proof);
    const t2 = performance.now();
    if (!ok) throw new Error(`[${name}] run ${i}: proof failed verification`);
    proveTimes.push(t1 - t0);
    verifyTimes.push(t2 - t1);
    lastProof = proof;
  }

  const proofSize = Buffer.byteLength(JSON.stringify(lastProof), "utf8");
  const vkJsonSize = statSync(vkPath).size;
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const result = {
    circuit: name,
    runs: RUNS,
    proveMsMean: mean(proveTimes),
    proveMsMin: Math.min(...proveTimes),
    proveMsMax: Math.max(...proveTimes),
    verifyMsMean: mean(verifyTimes),
    proofJsonBytes: proofSize,
    vkJsonBytes: vkJsonSize,
    zkeyBytes: zkeySize,
    wasmBytes: wasmSize,
  };

  console.log(`[${name}] prove: mean ${fmtMs(result.proveMsMean)} (min ${fmtMs(result.proveMsMin)}, max ${fmtMs(result.proveMsMax)}) over ${RUNS} runs`);
  console.log(`[${name}] verify: mean ${fmtMs(result.verifyMsMean)}`);
  console.log(`[${name}] proof.json: ${proofSize} bytes, vk.json: ${vkJsonSize} bytes, zkey: ${zkeySize} bytes, wasm: ${wasmSize} bytes`);
  return result;
}

async function main() {
  const results = [];
  for (const [name, buildInput] of Object.entries(CIRCUITS)) {
    const r = await benchCircuit(name, buildInput);
    if (r) results.push(r);
  }
  const outPath = join(__dirname, "results-latest.json");
  writeFileSync(outPath, JSON.stringify({ machine: { platform: process.platform, arch: process.arch, node: process.version }, results }, null, 2));
  console.log(`\nWrote ${outPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
