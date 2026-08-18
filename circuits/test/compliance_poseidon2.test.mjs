/**
 * compliance_poseidon2.test.mjs — Tests for the EXPERIMENTAL Poseidon2 Merkle-hashing
 * variant of compliance.circom (docs/research/2026-08-18-poseidon2-vs-poseidon.md).
 *
 * Same scope discipline as transfer_poseidon2.test.mjs: only the C2 credential Merkle
 * membership hash changed, so this file covers that change (happy path + malicious
 * witnesses) rather than re-testing C1/C3-C11, which are unchanged from compliance.circom
 * and already covered there.
 *
 * Full proof mode only — requires circuits/build-compliance-poseidon2/, built by
 * scripts/compile-compliance-poseidon2.sh.
 *
 * Run: node --experimental-vm-modules test/compliance_poseidon2.test.mjs
 */

import { buildPoseidon } from "circomlibjs";
import { bn254 } from "@taceo/poseidon2";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "..", "build-compliance-poseidon2");
const WASM_PATH = join(BUILD_DIR, "compliance_poseidon2_js", "compliance_poseidon2.wasm");
const ZKEY_PATH = join(BUILD_DIR, "compliance_poseidon2_final.zkey");
const VK_PATH = join(BUILD_DIR, "compliance_poseidon2_vk.json");

const MERKLE_DEPTH = 20;
const DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n;
const DOMAIN_CONTEXT_BINDING = 6n;

// Same constant as scripts/bench/witnesses.mjs and transfer_poseidon2.test.mjs — verified
// against ffjavascript's own bn128.js `r`, not memorized.
const BN254_FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let poseidonF = null;
function toBI(val) {
  if (typeof val === "bigint") return val;
  if (poseidonF && val instanceof Uint8Array) return poseidonF.toObject(val);
  return BigInt(val);
}

function poseidon2Compress(left, right) {
  const [out0] = bn254.t2.permutation([left, right]);
  return (out0 + left) % BN254_FR;
}

function merkleRootFromPathPoseidon2(leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < pathElements.length; i++) {
    const sibling = pathElements[i];
    const [left, right] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = poseidon2Compress(left, right);
  }
  return node;
}

function buildValidWitness(poseidon, {
  userSecret = 987654321n,
  kycLevel = 2n,
  expiryEpoch = 1000n,
  issuerId = 42n,
  currentEpoch = 500n,
  requiredKycLevel = 1n,
  transferNullifier = 111222333n,
  pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n),
  pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n),
} = {}) {
  const credentialLeaf = toBI(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));
  const merkleRoot = merkleRootFromPathPoseidon2(credentialLeaf, pathElements, pathIndices);
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

let passed = 0;
let failed = 0;
const FULL_PROOF_AVAILABLE = existsSync(WASM_PATH) && existsSync(ZKEY_PATH) && existsSync(VK_PATH);

console.log("=== Veil Compliance-Poseidon2 (experimental) Circuit Tests ===");
console.log(`Mode: ${FULL_PROOF_AVAILABLE ? "FULL PROOF (snarkjs Groth16)" : "SKIPPED (build-compliance-poseidon2/ not present)"}`);
if (!FULL_PROOF_AVAILABLE) {
  console.log("  Run: bash scripts/compile-compliance-poseidon2.sh");
}
console.log("");

async function test(name, fn) {
  if (!FULL_PROOF_AVAILABLE) {
    console.log(`  [SKIP] ${name}`);
    return;
  }
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? "Assertion failed");
}

async function proveAndVerify(groth16, vk, inputs) {
  const stringInputs = {};
  for (const [k, v] of Object.entries(inputs)) {
    stringInputs[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  const { proof, publicSignals } = await groth16.fullProve(stringInputs, WASM_PATH, ZKEY_PATH);
  const valid = await groth16.verify(vk, publicSignals, proof);
  return { proof, publicSignals, valid };
}

async function main() {
  const poseidon = await buildPoseidon();
  poseidonF = poseidon.F;
  let groth16 = null;
  let vk = null;

  if (FULL_PROOF_AVAILABLE) {
    const mod = await import("snarkjs");
    groth16 = mod.groth16;
    vk = JSON.parse(readFileSync(VK_PATH, "utf8"));
  }

  console.log("--- Happy paths ---");

  await test("P1: Valid KYC credential, real Groth16 proof verifies", async () => {
    const w = buildValidWitness(poseidon, {});
    const { valid } = await proveAndVerify(groth16, vk, w);
    assert(valid, "P1: proof must verify");
  });

  console.log("\n--- Malicious witnesses (must be rejected) ---");

  await test("N1: Forged credential membership — leaf never issued, root borrowed from a different credential", async () => {
    const userSecretIssued = 111n, userSecretForged = 999n;
    const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
    const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
    const leafIssued = toBI(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecretIssued, 2n, 1000n, 42n]));
    const rootForIssued = merkleRootFromPathPoseidon2(leafIssued, pathElements, pathIndices);

    const w = buildValidWitness(poseidon, { userSecret: userSecretForged, pathElements, pathIndices });
    assert(w.merkleRoot !== rootForIssued, "test setup: forged leaf must produce a different root");
    w.merkleRoot = rootForIssued;

    let threw = false;
    try { await proveAndVerify(groth16, vk, w); } catch { threw = true; }
    assert(threw, "N1: a credential that was never issued must not verify against another credential's root");
  });

  await test("N2: Tampered sibling in the credential path", async () => {
    const pathElements = Array.from({ length: MERKLE_DEPTH }, (_, i) => BigInt(i + 3));
    const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
    const w = buildValidWitness(poseidon, { pathElements, pathIndices });
    w.pathElements = [...w.pathElements];
    w.pathElements[12] = w.pathElements[12] + 1n;

    let threw = false;
    try { await proveAndVerify(groth16, vk, w); } catch { threw = true; }
    assert(threw, "N2: a tampered credential-tree sibling must invalidate the proof");
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("Test suite crashed:", err);
  process.exit(1);
});
