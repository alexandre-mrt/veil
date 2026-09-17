/**
 * transfer_poseidon2.test.mjs — Tests for the Poseidon2-Merkle research variant of the
 * Transfer circuit (docs/research/2026-09-17-poseidon2-merkle-compression.md).
 *
 * transfer_poseidon2.circom is byte-for-byte transfer.circom except C0 (Merkle membership),
 * which uses MerkleProof2 (Poseidon2 in 2-to-1 compression mode) instead of MerkleProof
 * (circomlib Poseidon(2) sponge). This file only exercises what that change could affect:
 * Merkle membership itself (happy path + two adversarial witnesses) and one full non-Merkle
 * happy path to confirm C1-C11 (untouched by this change) still hold end to end.
 *
 * For the full C1-C11 constraint matrix (range checks, field-overflow, nullifier/commitment
 * binding, chained transfers, etc.) see test/transfer.test.mjs — none of that logic changed
 * here, so it is not re-verified test-by-test in this file.
 *
 * Run: node --experimental-vm-modules test/transfer_poseidon2.test.mjs
 */

import { buildPoseidon } from "circomlibjs";
import { bn254 } from "@taceo/poseidon2";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "..", "build-poseidon2");
const WASM_PATH = join(BUILD_DIR, "transfer_poseidon2_js", "transfer_poseidon2.wasm");
const ZKEY_PATH = join(BUILD_DIR, "transfer_poseidon2_final.zkey");
const VK_PATH = join(BUILD_DIR, "transfer_poseidon2_vk.json");

const MAX_U64 = 2n ** 64n;
const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const MERKLE_DEPTH = 20;
const BN254_FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let poseidonF = null;
function toBI(val) {
  if (typeof val === "bigint") return val;
  if (poseidonF && val instanceof Uint8Array) return poseidonF.toObject(val);
  return BigInt(val);
}

/** Poseidon2 2-to-1 compression node hash — matches MerkleProof2 exactly:
 *  out = Poseidon2(2)([l, r])[0] + l  (feed-forward on the FIRST mux output, i.e. mux.out[0]). */
function compress2(l, r) {
  const [p0] = bn254.t2.permutation([l, r]);
  return (p0 + l) % BN254_FR;
}

/** Recompute a depth-20 Merkle root from a leaf and its authentication path using
 * MerkleProof2's Poseidon2-compression node hash. */
function merkleRootFromPathPoseidon2(leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    const sibling = pathElements[i];
    const [left, right] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = compress2(left, right);
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
    cumulativeOld, cumulativeNew, txAmount,
    randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

let passed = 0;
let failed = 0;
const FULL_PROOF_AVAILABLE = existsSync(WASM_PATH) && existsSync(ZKEY_PATH) && existsSync(VK_PATH);

console.log("=== Veil Transfer-Poseidon2 Circuit Tests (research variant) ===");
console.log(`Mode: ${FULL_PROOF_AVAILABLE ? "FULL PROOF (snarkjs Groth16)" : "SKIPPED (run poseidon-arity/transfer_poseidon2 compile step first)"}`);
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

async function loadSnarkjs() {
  const mod = await import("snarkjs");
  return mod.groth16;
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
    groth16 = await loadSnarkjs();
    const { readFileSync } = await import("fs");
    vk = JSON.parse(readFileSync(VK_PATH, "utf8"));
  }

  // ── P1: Genesis transfer, empty Merkle path (leaf at index 0, all-zero siblings) ──
  await test("P1: Genesis transfer, valid Poseidon2-compression Merkle membership", async () => {
    const w = buildValidWitness(poseidon, { cumulativeOld: 0n, txAmount: 100n, userSecret: 111n });
    const { valid } = await proveAndVerify(groth16, vk, w);
    assert(valid, "P1: Groth16 proof must verify");
  });

  // ── P2: Non-trivial path — leaf at a mid-tree position with real (non-zero) siblings ──
  await test("P2: Non-genesis Merkle position with mixed left/right siblings", async () => {
    const pathElements = Array.from({ length: MERKLE_DEPTH }, (_, i) => BigInt(1000 + i));
    const pathIndices = Array.from({ length: MERKLE_DEPTH }, (_, i) => BigInt(i % 2));
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 500n, txAmount: 25n, userSecret: 222n, randomnessOld: 5n,
      pathElements, pathIndices,
    });
    const { valid } = await proveAndVerify(groth16, vk, w);
    assert(valid, "P2: Groth16 proof must verify");
  });

  // ── N1 (negative): forged sibling — pathElements tampered after root was fixed ──
  // A malicious prover who doesn't actually know a valid authentication path for their
  // commitment cannot substitute an arbitrary sibling and still hit the public merkleRoot:
  // MerkleProof2 is a hard equality constraint (merkleRoot === membershipProof.root), not an
  // assertion the prover can route around by choosing different private inputs.
  await test("N1: Forged Merkle sibling must be rejected", async () => {
    const w = buildValidWitness(poseidon, { cumulativeOld: 0n, txAmount: 100n, userSecret: 333n });
    w.pathElements = [...w.pathElements];
    w.pathElements[3] = w.pathElements[3] + 1n; // tamper with one sibling post-hoc
    let threw = false;
    try {
      await proveAndVerify(groth16, vk, w);
    } catch {
      threw = true;
    }
    assert(threw, "N1: Proof generation must fail for a forged sibling");
  });

  // ── N2 (negative): wrong path index (claims the leaf is on the other side) ──
  await test("N2: Flipped pathIndices bit must be rejected", async () => {
    const pathElements = Array.from({ length: MERKLE_DEPTH }, (_, i) => BigInt(1000 + i));
    const pathIndices = Array.from({ length: MERKLE_DEPTH }, (_, i) => BigInt(i % 2));
    const w = buildValidWitness(poseidon, {
      cumulativeOld: 500n, txAmount: 25n, userSecret: 222n, randomnessOld: 5n,
      pathElements, pathIndices,
    });
    w.pathIndices = [...w.pathIndices];
    w.pathIndices[0] = w.pathIndices[0] === 0n ? 1n : 0n; // flip one bit after root was computed
    let threw = false;
    try {
      await proveAndVerify(groth16, vk, w);
    } catch {
      threw = true;
    }
    assert(threw, "N2: Proof generation must fail for a flipped path index");
  });

  // ── N3 (negative): leaf substitution — claims membership of a commitment never inserted ──
  await test("N3: Unrelated oldCommitment (not the tree's actual leaf) must be rejected", async () => {
    const w = buildValidWitness(poseidon, { cumulativeOld: 0n, txAmount: 100n, userSecret: 444n });
    // Swap in a commitment for a different userSecret, but keep the original merkleRoot —
    // the circuit must catch that this "leaf" was never hashed into that root.
    w.oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, 0n, 0n, 999999n]));
    let threw = false;
    try {
      await proveAndVerify(groth16, vk, w);
    } catch {
      threw = true;
    }
    assert(threw, "N3: Proof generation must fail for a substituted leaf");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
