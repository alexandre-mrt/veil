/**
 * transfer_poseidon2.test.mjs — Tests for the EXPERIMENTAL Poseidon2 Merkle-hashing
 * variant of transfer.circom (docs/research/2026-08-18-poseidon2-vs-poseidon.md).
 *
 * This is not a full re-run of transfer.test.mjs's 43 cases: transfer_poseidon2.circom
 * changes exactly one thing (the C0 Merkle-membership hash), so this file targets that
 * change specifically — real-proof happy paths plus malicious-witness rejection for the
 * new hash construction — rather than re-testing constraints C1-C11, which are byte-for-byte
 * unchanged from transfer.circom and already covered there.
 *
 * Full proof mode only (requires circuits/build-transfer-poseidon2/, built by
 * scripts/compile-transfer-poseidon2.sh) — there is no circomlibjs fallback for Poseidon2,
 * so unlike the other *.test.mjs files this one has no hash-only simulation mode.
 *
 * Run: node --experimental-vm-modules test/transfer_poseidon2.test.mjs
 */

import { buildPoseidon } from "circomlibjs";
import { bn254 } from "@taceo/poseidon2";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "..", "build-transfer-poseidon2");
const WASM_PATH = join(BUILD_DIR, "transfer_poseidon2_js", "transfer_poseidon2.wasm");
const ZKEY_PATH = join(BUILD_DIR, "transfer_poseidon2_final.zkey");
const VK_PATH = join(BUILD_DIR, "transfer_poseidon2_vk.json");

const MERKLE_DEPTH = 20;
const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;

// Same constant as scripts/bench/witnesses.mjs — verified against ffjavascript's own
// bn128.js `r` (node_modules/ffjavascript/src/bn128.js), not memorized. An earlier,
// wrong version of this constant silently broke Merkle roots at depth >= 3 (see the
// research report) — this KAT-style test file is partly what would have caught it.
const BN254_FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let poseidonF = null;
function toBI(val) {
  if (typeof val === "bigint") return val;
  if (poseidonF && val instanceof Uint8Array) return poseidonF.toObject(val);
  return BigInt(val);
}

// Matches circuits/templates/merkle_proof_poseidon2.circom exactly: Poseidon2(2)
// compression mode, out = permute(left, right)[0] + left.
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
  cumulativeOld = 0n,
  txAmount = 100n,
  randomnessOld = 0n,
  randomnessNew = 12345n,
  userSecret = 987654321n,
  epochId = 1n,
  threshold = 1_000_000_000n,
  salt = 99n,
  pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n),
  pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n),
} = {}) {
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
  const merkleRoot = merkleRootFromPathPoseidon2(oldCommitment, pathElements, pathIndices);
  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

let passed = 0;
let failed = 0;
const FULL_PROOF_AVAILABLE = existsSync(WASM_PATH) && existsSync(ZKEY_PATH) && existsSync(VK_PATH);

console.log("=== Veil Transfer-Poseidon2 (experimental) Circuit Tests ===");
console.log(`Mode: ${FULL_PROOF_AVAILABLE ? "FULL PROOF (snarkjs Groth16)" : "SKIPPED (build-transfer-poseidon2/ not present)"}`);
if (!FULL_PROOF_AVAILABLE) {
  console.log("  Run: bash scripts/compile-transfer-poseidon2.sh");
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

  await test("P1: Genesis transfer, real Groth16 proof verifies", async () => {
    const w = buildValidWitness(poseidon, { cumulativeOld: 0n, txAmount: 100n, randomnessOld: 0n });
    const { valid } = await proveAndVerify(groth16, vk, w);
    assert(valid, "P1: proof must verify");
  });

  await test("P2: Non-trivial Merkle path (leaf not at index 0, mixed left/right siblings)", async () => {
    const userSecret = 555n, cumulativeOld = 250n;
    const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, 0n, userSecret]));
    // A mixed path: alternating left/right positions with non-zero sibling hashes,
    // unlike the all-zero canonical path used elsewhere — exercises the mux, not just
    // the hash, since a same-shaped-but-wrong path is what T2/T3 below try to forge.
    const pathElements = Array.from({ length: MERKLE_DEPTH }, (_, i) => BigInt(1000 + i));
    const pathIndices = Array.from({ length: MERKLE_DEPTH }, (_, i) => BigInt(i % 2));
    const w = buildValidWitness(poseidon, {
      cumulativeOld, txAmount: 50n, randomnessOld: 0n, userSecret, pathElements, pathIndices,
    });
    const { valid } = await proveAndVerify(groth16, vk, w);
    assert(valid, "P2: proof with a non-trivial path must verify");
  });

  console.log("\n--- Malicious witnesses (must be rejected) ---");

  await test("N1: Forged membership — commitment never inserted, path fabricated to match a stale root", async () => {
    // The core Merkle-fraud attempt: a prover who does NOT know a valid path for their
    // commitment tries to reuse a root from a DIFFERENT (unrelated) leaf's tree, hoping
    // the verifier only checks "some root" rather than "the on-chain root for THIS leaf".
    // Concretely: compute a merkleRoot for leaf A, then submit a proof claiming leaf B
    // (a different, unpublished commitment) is a member of that same root.
    const userSecretA = 111n, userSecretB = 999n;
    const leafA = toBI(poseidon([DOMAIN_COMMITMENT, 0n, 0n, userSecretA]));
    const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
    const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
    const rootForA = merkleRootFromPathPoseidon2(leafA, pathElements, pathIndices);

    const w = buildValidWitness(poseidon, {
      cumulativeOld: 0n, txAmount: 100n, randomnessOld: 0n, userSecret: userSecretB,
      pathElements, pathIndices,
    });
    w.merkleRoot = rootForA; // matches leaf A's root, NOT leaf B's (w.oldCommitment)'s root
    assert(w.oldCommitment !== leafA, "test setup: oldCommitment must differ from leafA");

    let threw = false;
    try { await proveAndVerify(groth16, vk, w); } catch { threw = true; }
    assert(threw, "N1: proof for an uninserted commitment forged against another leaf's root must fail");
  });

  await test("N2: Tampered sibling — attacker flips one pathElement after computing the honest root", async () => {
    const userSecret = 222n, cumulativeOld = 0n;
    const pathElements = Array.from({ length: MERKLE_DEPTH }, (_, i) => BigInt(i + 1));
    const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
    const w = buildValidWitness(poseidon, {
      cumulativeOld, txAmount: 10n, randomnessOld: 0n, userSecret, pathElements, pathIndices,
    });
    // Tamper with one sibling in the witness AFTER merkleRoot was computed honestly —
    // the on-chain merkleRoot public input is unchanged, so this must fail C0.
    w.pathElements = [...w.pathElements];
    w.pathElements[10] = w.pathElements[10] + 1n;

    let threw = false;
    try { await proveAndVerify(groth16, vk, w); } catch { threw = true; }
    assert(threw, "N2: tampered sibling must invalidate the Merkle proof");
  });

  await test("N3: Flipped path index — attacker swaps left/right at one level", async () => {
    const userSecret = 333n, cumulativeOld = 0n;
    const pathElements = Array.from({ length: MERKLE_DEPTH }, (_, i) => BigInt(i + 7));
    const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
    const w = buildValidWitness(poseidon, {
      cumulativeOld, txAmount: 10n, randomnessOld: 0n, userSecret, pathElements, pathIndices,
    });
    w.pathIndices = [...w.pathIndices];
    w.pathIndices[5] = 1n; // flip left/right at level 5 only — merkleRoot public input unchanged

    let threw = false;
    try { await proveAndVerify(groth16, vk, w); } catch { threw = true; }
    assert(threw, "N3: flipping a path index bit must invalidate the Merkle proof (Poseidon2 compression is not commutative-safe to swap blindly)");
  });

  await test("N4: Non-binary path index (malicious prover sets pathIndices[i] = 2)", async () => {
    // MerkleProofPoseidon2 has the same `pathIndices[i]*(1-pathIndices[i])===0` binary
    // constraint as the original merkle_proof.circom — confirms the Poseidon2 swap didn't
    // drop it. Not enforced by MultiMux1 itself, which would silently accept any field
    // value as a linear-interpolation coefficient.
    const userSecret = 444n, cumulativeOld = 0n;
    const w = buildValidWitness(poseidon, { cumulativeOld, txAmount: 10n, randomnessOld: 0n, userSecret });
    w.pathIndices = [...w.pathIndices];
    w.pathIndices[0] = 2n;

    let threw = false;
    try { await proveAndVerify(groth16, vk, w); } catch { threw = true; }
    assert(threw, "N4: non-binary pathIndices must be rejected by the binary constraint");
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("Test suite crashed:", err);
  process.exit(1);
});
