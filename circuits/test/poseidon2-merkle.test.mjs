/**
 * poseidon2-merkle.test.mjs — Negative & positive tests for transfer_v2.circom /
 * compliance_v2.circom (docs/research/2026-07-30-poseidon2-merkle-hash.md).
 *
 * Only the depth-20 Merkle-path hash changed (circomlib Poseidon(2) -> Poseidon2Hash2,
 * see circuits/templates/merkle_proof_v2.circom). Every other constraint is byte-identical
 * to transfer.circom / compliance.circom, which already have their own full suites
 * (transfer.test.mjs, compliance.test.mjs) — this file only exercises what's new: does the
 * circuit actually enforce the Poseidon2 permutation, and does it reject the malicious
 * witnesses that would have broken circomlib's Poseidon too.
 *
 * Run: node test/poseidon2-merkle.test.mjs
 * Requires: build_v2/{transfer_v2,compliance_v2}{_js/*.wasm,_final.zkey,_vk.json}
 *   (circom {transfer,compliance}_v2.circom --r1cs --wasm --sym --output build_v2 -l node_modules
 *    then snarkjs groth16 setup/contribute/export against build_v2/pot15_final.ptau)
 */
import { buildPoseidon } from "circomlibjs";
import { bn254 } from "@taceo/poseidon2";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "..", "build_v2");

const MERKLE_DEPTH = 20;
const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n;
const DOMAIN_CONTEXT_BINDING = 6n;

let passed = 0, failed = 0;
async function test(name, fn) {
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

// Poseidon2Hash2 convention: state=[0,left,right], permute, out=state[0].
// Must match circuits/lib/poseidon2/poseidon2_hash2.circom exactly.
function poseidon2Hash2(left, right) {
  return bn254.t3.permutation([0n, left, right])[0];
}

// The hash the OLD (pre-Poseidon2) circuit used — circomlib Poseidon(2). Used below to
// prove the new circuit does NOT silently accept a Merkle proof built with the old hash.
function oldPoseidonHash2(poseidon, F, left, right) {
  return F.toObject(poseidon([left, right]));
}

function merkleRootFromPathV2(leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    const sibling = pathElements[i];
    const [left, right] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = poseidon2Hash2(left, right);
  }
  return node;
}

function stringify(inputs) {
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  return out;
}

async function proveAndVerify(circuitName, inputs) {
  const wasmPath = join(BUILD_DIR, `${circuitName}_js`, `${circuitName}.wasm`);
  const zkeyPath = join(BUILD_DIR, `${circuitName}_final.zkey`);
  const vkPath = join(BUILD_DIR, `${circuitName}_vk.json`);
  const vk = JSON.parse(readFileSync(vkPath, "utf-8"));
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(stringify(inputs), wasmPath, zkeyPath);
  const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
  return valid;
}

async function assertAccepted(circuitName, inputs, label) {
  const valid = await proveAndVerify(circuitName, inputs);
  assert(valid, `${label}: expected proof to verify, but verify() returned false`);
}

async function assertRejected(circuitName, inputs, label) {
  let proofSucceeded = false;
  let verifiedValid = false;
  try {
    verifiedValid = await proveAndVerify(circuitName, inputs);
    proofSucceeded = true;
  } catch {
    // fullProve/verify threw — witness generation or proving failed, which is a pass
    // for this assertion (the malicious witness was rejected before it could verify).
  }
  if (proofSucceeded) {
    assert(!verifiedValid, `${label}: proof unexpectedly verified as valid`);
  }
}

function buildTransferV2Witness(poseidon, F, overrides = {}) {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = F.toObject(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = F.toObject(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = F.toObject(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const txAmountHash = F.toObject(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const merkleRoot = merkleRootFromPathV2(oldCommitment, pathElements, pathIndices);
  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
    ...overrides,
  };
}

function buildComplianceV2Witness(poseidon, F, overrides = {}) {
  const userSecret = 987654321n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 42n;
  const currentEpoch = 500n, requiredKycLevel = 1n, transferNullifier = 111222333n;
  const credentialLeaf = F.toObject(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));
  const pathElements = [];
  const pathIndices = [];
  let current = credentialLeaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    pathElements.push(0n);
    pathIndices.push(0n);
    current = poseidon2Hash2(current, 0n);
  }
  const merkleRoot = current;
  const contextId = F.toObject(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]));
  const nullifier = F.toObject(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]));
  const validCredential = expiryEpoch >= currentEpoch && kycLevel >= requiredKycLevel ? 1n : 0n;
  return {
    merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
    ...overrides,
  };
}

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const TRANSFER_READY = ["transfer_v2_js/transfer_v2.wasm", "transfer_v2_final.zkey", "transfer_v2_vk.json"]
    .every((p) => existsSync(join(BUILD_DIR, p)));
  const COMPLIANCE_READY = ["compliance_v2_js/compliance_v2.wasm", "compliance_v2_final.zkey", "compliance_v2_vk.json"]
    .every((p) => existsSync(join(BUILD_DIR, p)));

  console.log("=== Poseidon2 Merkle-hash tests (transfer_v2 / compliance_v2) ===");
  console.log(`transfer_v2 artifacts: ${TRANSFER_READY ? "found" : "MISSING — skipping"}`);
  console.log(`compliance_v2 artifacts: ${COMPLIANCE_READY ? "found" : "MISSING — skipping"}\n`);

  if (TRANSFER_READY) {
    await test("P1: valid transfer_v2 witness (real Poseidon2 Merkle proof) is accepted", async () => {
      const w = buildTransferV2Witness(poseidon, F);
      await assertAccepted("transfer_v2", w, "P1");
    });

    await test("N1: transfer_v2 — merkleRoot off by one is rejected", async () => {
      const w = buildTransferV2Witness(poseidon, F);
      w.merkleRoot = w.merkleRoot + 1n;
      await assertRejected("transfer_v2", w, "N1");
    });

    await test("N2: transfer_v2 — tampered Merkle sibling is rejected", async () => {
      const w = buildTransferV2Witness(poseidon, F);
      w.pathElements = [...w.pathElements];
      w.pathElements[0] = 999n;
      await assertRejected("transfer_v2", w, "N2");
    });

    await test("N3: transfer_v2 — a Merkle root computed with the OLD Poseidon hash (not Poseidon2) is rejected", async () => {
      // Malicious-prover scenario: an attacker (or a relayer replaying a stale client)
      // submits a Merkle authentication path whose root was computed with circomlib's
      // Poseidon(2) — the hash function the deployed VK used *before* this swap — against
      // the new Poseidon2 VK. If the swap were somehow not actually enforced by the
      // constraint system (e.g. a template wiring bug that left the old hasher live),
      // this witness would incorrectly verify. It must not.
      const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
      const userSecret = 555n, epochId = 1n, threshold = 1_000_000_000n, salt = 1n;
      const cumulativeNew = cumulativeOld + txAmount;
      const oldCommitment = F.toObject(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
      const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
      const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
      let node = oldCommitment;
      for (let i = 0; i < MERKLE_DEPTH; i++) {
        node = oldPoseidonHash2(poseidon, F, node, 0n); // OLD hash, not Poseidon2Hash2
      }
      const w = buildTransferV2Witness(poseidon, F, {
        cumulativeOld, txAmount, cumulativeNew, randomnessOld, randomnessNew, userSecret,
        epochId, threshold, salt, pathElements, pathIndices,
        oldCommitment,
        newCommitment: F.toObject(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret])),
        nullifier: F.toObject(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld])),
        txAmountHash: F.toObject(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt])),
        merkleRoot: node, // root computed with the OLD hash
      });
      await assertRejected("transfer_v2", w, "N3");
    });

    await test("N4: transfer_v2 — non-boolean pathIndices rejected (witness generation must fail)", async () => {
      const w = buildTransferV2Witness(poseidon, F);
      w.pathIndices = [...w.pathIndices];
      w.pathIndices[5] = 2n;
      let threw = false;
      try {
        await proveAndVerify("transfer_v2", w);
      } catch {
        threw = true;
      }
      assert(threw, "N4: non-boolean path index must fail witness generation");
    });
  }

  if (COMPLIANCE_READY) {
    await test("P2: valid compliance_v2 witness (real Poseidon2 Merkle proof) is accepted", async () => {
      const w = buildComplianceV2Witness(poseidon, F);
      await assertAccepted("compliance_v2", w, "P2");
    });

    await test("N5: compliance_v2 — merkleRoot off by one is rejected", async () => {
      const w = buildComplianceV2Witness(poseidon, F);
      w.merkleRoot = w.merkleRoot + 1n;
      await assertRejected("compliance_v2", w, "N5");
    });

    await test("N6: compliance_v2 — a credential root computed with the OLD Poseidon hash is rejected", async () => {
      const userSecret = 777n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 42n;
      const currentEpoch = 500n, requiredKycLevel = 1n, transferNullifier = 999n;
      const credentialLeaf = F.toObject(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));
      let node = credentialLeaf;
      const pathElements = [], pathIndices = [];
      for (let i = 0; i < MERKLE_DEPTH; i++) {
        pathElements.push(0n);
        pathIndices.push(0n);
        node = oldPoseidonHash2(poseidon, F, node, 0n); // OLD hash, not Poseidon2Hash2
      }
      const w = buildComplianceV2Witness(poseidon, F, {
        userSecret, kycLevel, expiryEpoch, issuerId, currentEpoch, requiredKycLevel, transferNullifier,
        pathElements, pathIndices,
        contextId: F.toObject(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret])),
        nullifier: F.toObject(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret,
          F.toObject(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]))])),
        validCredential: 1n,
        merkleRoot: node,
      });
      await assertRejected("compliance_v2", w, "N6");
    });
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
