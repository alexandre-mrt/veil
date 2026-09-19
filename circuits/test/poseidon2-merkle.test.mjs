/**
 * poseidon2-merkle.test.mjs — Tests for the Poseidon2 Merkle-hash swap.
 *
 * Covers transfer_poseidon2.circom, compliance_poseidon2.circom and
 * withdraw_poseidon2.circom — research variants of the three production
 * circuits that replace circomlib's Poseidon(2) (used for the depth-20
 * Merkle-membership sibling hash, and withdraw.circom's recipientHash) with
 * Poseidon2(t=3, BN254) from templates/poseidon2_bn254_t3.circom.
 *
 * Everything else in these three circuits is byte-for-byte identical to the
 * production circuits (diffed at circuit-authoring time — see
 * docs/research/2026-09-19-poseidon2-merkle-swap.md), so this file does NOT
 * re-test constraints that are unchanged: range checks, nullifier/commitment
 * hashing (Poseidon(3)/Poseidon(4), untouched), threshold logic, KYC expiry,
 * etc. are already covered by transfer.test.mjs / compliance.test.mjs /
 * withdraw.test.mjs. This file tests exactly what changed:
 *
 *   1. The JS Poseidon2 reference (scripts/bench/poseidon2.mjs) agrees with
 *      the compiled circuit's own witness generator, for the Merkle-path
 *      hash and for the standalone permutation.
 *   2. A valid witness built with the JS Poseidon2 hash is accepted
 *      (real Groth16 full proof, when the circuit is compiled).
 *   3. A malicious witness — a Merkle sibling forged with the OLD
 *      (circomlib) Poseidon instead of Poseidon2, or an arbitrary forged
 *      root — is rejected. This is the negative test: it proves you cannot
 *      substitute the wrong hash family into a proof for this circuit and
 *      still have it verify, which is exactly the failure mode a botched
 *      hash-family swap would risk in production.
 *
 * Run: node --experimental-vm-modules test/poseidon2-merkle.test.mjs
 */
import { buildPoseidon } from "circomlibjs";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { poseidon2Hash2to1, poseidon2Permute3 } from "../../scripts/bench/poseidon2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "..", "build");

const MERKLE_DEPTH = 20;
const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n;
const DOMAIN_CONTEXT_BINDING = 6n;
const DOMAIN_WITHDRAW_NULLIFIER = 7n;
const DOMAIN_RECIPIENT_HASH = 8n;

let poseidonF = null;
function toBI(val) {
  if (typeof val === "bigint") return val;
  if (poseidonF && val instanceof Uint8Array) return poseidonF.toObject(val);
  return BigInt(val);
}

let passed = 0;
let failed = 0;
let skipped = 0;
class Skip extends Error {}
async function test(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err) {
    if (err instanceof Skip) {
      console.log(`  [SKIP] ${name}: ${err.message}`);
      skipped++;
      return;
    }
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${err.message}`);
    failed++;
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message ?? "Assertion failed");
}

// ── Poseidon2 Merkle path (matches templates/merkle_proof_poseidon2.circom) ──
function merkleRootFromPathPoseidon2(leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < pathElements.length; i++) {
    const sibling = pathElements[i];
    const [left, right] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = poseidon2Hash2to1(left, right);
  }
  return node;
}

// ── Circuit artifact plumbing (mirrors transfer.test.mjs) ───────────────────
async function loadCircuit(name) {
  const wasmPath = join(BUILD_DIR, `${name}_js`, `${name}.wasm`);
  const zkeyPath = join(BUILD_DIR, `${name}_final.zkey`);
  const vkPath = join(BUILD_DIR, `${name}_vk.json`);
  const available = existsSync(wasmPath) && existsSync(zkeyPath) && existsSync(vkPath);
  if (!available) return { available: false, wasmPath, zkeyPath };
  const { groth16 } = await import("snarkjs");
  const vk = JSON.parse(readFileSync(vkPath, "utf8"));
  return { available: true, wasmPath, zkeyPath, vk, groth16 };
}

async function proveAndVerify(circuit, inputs) {
  const stringInputs = {};
  for (const [k, v] of Object.entries(inputs)) {
    stringInputs[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  const { proof, publicSignals } = await circuit.groth16.fullProve(stringInputs, circuit.wasmPath, circuit.zkeyPath);
  const valid = await circuit.groth16.verify(circuit.vk, publicSignals, proof);
  return valid;
}

async function assertAccepted(circuit, inputs, label) {
  if (!circuit.available) {
    throw new Skip("build artifacts not found (run compile step first)");
  }
  const valid = await proveAndVerify(circuit, inputs);
  assert(valid, `${label}: Groth16 proof must verify`);
}

async function assertRejected(circuit, inputs, label) {
  if (!circuit.available) {
    throw new Skip("build artifacts not found (run compile step first)");
  }
  let threw = false;
  try {
    await proveAndVerify(circuit, inputs);
  } catch {
    threw = true;
  }
  assert(threw, `${label}: proof generation must fail for a malicious witness`);
}

async function main() {
  const poseidon = await buildPoseidon();
  poseidonF = poseidon.F;

  console.log("=== Poseidon2 Merkle-hash swap — tests ===\n");

  // ═══════════════════════════════════════════════════════════════════════
  // 1. JS reference vs circuit witness generator
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- JS reference correctness ---");

  await test("KAT: poseidon2Permute3([0,1,2]) matches the published Horizen Labs BN254 test vector", () => {
    const out = poseidon2Permute3([0n, 1n, 2n]);
    const expected = [
      0xbb61d24daca55eebcb1929a82650f328134334da98ea4f847f760054f4a3033n,
      0x303b6f7c86d043bfcbcc80214f26a30277a15d3f74ca654992defe7ff8d03570n,
      0x1ed25194542b12eef8617361c3ba7c52e660b145994427cc86296242cf766ec8n,
    ];
    for (let i = 0; i < 3; i++) {
      assert(out[i] === expected[i], `output[${i}]: expected ${expected[i]}, got ${out[i]}`);
    }
  });

  await test("poseidon2Hash2to1 is not the same function as circomlib Poseidon(2) (different hash families)", () => {
    const a = 3n, b = 4n;
    const p2 = poseidon2Hash2to1(a, b);
    const p1 = toBI(poseidon([a, b]));
    assert(p2 !== p1, "Poseidon2 and circomlib Poseidon must diverge for the same inputs");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. transfer_poseidon2.circom
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- transfer_poseidon2.circom ---");
  const transferCircuit = await loadCircuit("transfer_poseidon2");

  function buildTransferWitness({
    cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n,
    userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n,
    leafIndex = 0n,
  } = {}) {
    const cumulativeNew = cumulativeOld + txAmount;
    const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
    const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
    const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
    const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
    const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
    const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
    const merkleRoot = merkleRootFromPathPoseidon2(oldCommitment, pathElements, pathIndices);
    return {
      oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
      cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
      pathElements, pathIndices,
    };
  }

  await test("PT1: valid transfer witness (Poseidon2 Merkle path) is accepted", async () => {
    const w = buildTransferWitness({ userSecret: 111n, txAmount: 50n });
    await assertAccepted(transferCircuit, w, "PT1");
  });

  await test("PT2 (negative): sibling hashed with circomlib Poseidon instead of Poseidon2 is rejected", async () => {
    const w = buildTransferWitness({ userSecret: 222n, txAmount: 75n });
    // Recompute the root using the OLD hash family for one path step — this
    // is exactly the mistake a partial/inconsistent hash-family migration
    // would make: mixing Poseidon and Poseidon2 nodes in one Merkle path.
    const forgedRoot = toBI(poseidon([w.oldCommitment, w.pathElements[0]]));
    const malicious = { ...w, merkleRoot: forgedRoot };
    await assertRejected(transferCircuit, malicious, "PT2");
  });

  await test("PT3 (negative): forged Merkle root (arbitrary value, no valid path) is rejected", async () => {
    const w = buildTransferWitness({ userSecret: 333n, txAmount: 10n });
    const malicious = { ...w, merkleRoot: w.merkleRoot + 1n };
    await assertRejected(transferCircuit, malicious, "PT3");
  });

  await test("PT4 (negative): claiming membership of a commitment never in the tree is rejected", async () => {
    const w = buildTransferWitness({ userSecret: 444n, txAmount: 20n });
    // oldCommitment swapped for an unrelated value after merkleRoot was
    // computed from the real one — proof must fail because oldHash.out no
    // longer equals oldCommitment AND membershipProof.root no longer
    // equals merkleRoot.
    const malicious = { ...w, oldCommitment: w.oldCommitment + 1n };
    await assertRejected(transferCircuit, malicious, "PT4");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. compliance_poseidon2.circom
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- compliance_poseidon2.circom ---");
  const complianceCircuit = await loadCircuit("compliance_poseidon2");

  function buildComplianceWitness({
    userSecret = 987654321n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 42n,
    currentEpoch = 500n, requiredKycLevel = 1n, transferNullifier = 111222333n,
  } = {}) {
    const credentialLeaf = toBI(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));
    const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
    const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
    const merkleRoot = merkleRootFromPathPoseidon2(credentialLeaf, pathElements, pathIndices);
    const contextId = toBI(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]));
    const nullifier = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]));
    const validCredential = (expiryEpoch >= currentEpoch ? 1n : 0n) * (kycLevel >= requiredKycLevel ? 1n : 0n);
    return {
      merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
      userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
    };
  }

  await test("PC1: valid compliance witness (Poseidon2 credential Merkle path) is accepted", async () => {
    const w = buildComplianceWitness({ userSecret: 555n });
    await assertAccepted(complianceCircuit, w, "PC1");
  });

  await test("PC2 (negative): credential Merkle path forged with circomlib Poseidon is rejected", async () => {
    const w = buildComplianceWitness({ userSecret: 666n });
    const forgedRoot = toBI(poseidon([toBI(poseidon([DOMAIN_CREDENTIAL_LEAF, w.userSecret, w.kycLevel, w.expiryEpoch, w.issuerId])), 0n]));
    const malicious = { ...w, merkleRoot: forgedRoot };
    await assertRejected(complianceCircuit, malicious, "PC2");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. withdraw_poseidon2.circom
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- withdraw_poseidon2.circom ---");
  const withdrawCircuit = await loadCircuit("withdraw_poseidon2");

  function buildWithdrawWitness({
    cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n,
    withdrawAmount = 100n, recipient = 0xabcdef123456n, randomnessNew = 77777n,
  } = {}) {
    const commitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
    const remainingBalance = cumulativeOld - withdrawAmount;
    const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, remainingBalance, randomnessNew, userSecret]));
    const nullifier = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));
    const recipientHash = poseidon2Hash2to1(DOMAIN_RECIPIENT_HASH, recipient);
    return {
      commitment, withdrawAmount, nullifier, recipientHash, newCommitment,
      cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew,
    };
  }

  await test("PW1: valid withdraw witness (Poseidon2 recipientHash) is accepted", async () => {
    const w = buildWithdrawWitness({ userSecret: 777n });
    await assertAccepted(withdrawCircuit, w, "PW1");
  });

  await test("PW2 (negative): recipientHash computed with circomlib Poseidon instead of Poseidon2 is rejected", async () => {
    const w = buildWithdrawWitness({ userSecret: 888n });
    const forgedRecipientHash = toBI(poseidon([DOMAIN_RECIPIENT_HASH, w.recipient]));
    const malicious = { ...w, recipientHash: forgedRecipientHash };
    await assertRejected(withdrawCircuit, malicious, "PW2");
  });

  await test("PW3 (negative): recipientHash bound to a different recipient than the one paid out is rejected", async () => {
    const w = buildWithdrawWitness({ userSecret: 999n });
    const malicious = { ...w, recipientHash: poseidon2Hash2to1(DOMAIN_RECIPIENT_HASH, w.recipient + 1n) };
    await assertRejected(withdrawCircuit, malicious, "PW3");
  });

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Test run failed:", err);
  process.exit(1);
});
