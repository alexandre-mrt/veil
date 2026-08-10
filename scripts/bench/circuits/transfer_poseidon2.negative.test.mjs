/**
 * transfer_poseidon2.negative.test.mjs — negative tests for the Poseidon2
 * research prototype (scripts/bench/circuits/transfer_poseidon2.circom).
 *
 * Mirrors circuits/test/transfer.test.mjs's assertRejected/assertAccepted
 * pattern (T41/T42/T43-equivalent) against the new Poseidon2(3) Merkle
 * sponge and Poseidon2(4) txAmountHash, using real Groth16 proofs (not
 * hash-only simulation) — a malicious witness must fail proof generation,
 * not just look wrong.
 *
 * Prerequisite: scripts/bench/circuits/build.sh (produces the wasm/zkey this
 * reads from build/transfer_poseidon2_*).
 *
 * Run: node --experimental-vm-modules scripts/bench/circuits/transfer_poseidon2.negative.test.mjs
 */
import { buildPoseidon } from "circomlibjs";
import { bn254 } from "@taceo/poseidon2";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import assert from "assert";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "build", "transfer_poseidon2_js", "transfer_poseidon2.wasm");
const ZKEY_PATH = join(__dirname, "build", "transfer_poseidon2_final.zkey");
const VK_PATH = join(__dirname, "build", "transfer_poseidon2_vk.json");

const DOMAIN_COMMITMENT = 1n, DOMAIN_NULLIFIER = 2n, DOMAIN_TX_AMOUNT = 3n;
const MERKLE_DEPTH = 20;

function toBI(F, val) {
  if (typeof val === "bigint") return val;
  if (val instanceof Uint8Array) return F.toObject(val);
  return BigInt(val);
}

function poseidon2Node(left, right) {
  return bn254.t3.permutation([0n, left, right])[0];
}

function merkleRootPoseidon2(leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    const [l, r] = pathIndices[i] === 0n ? [node, pathElements[i]] : [pathElements[i], node];
    node = poseidon2Node(l, r);
  }
  return node;
}

function buildValidWitness(poseidon, F) {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = toBI(F, poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(F, poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(F, poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const txAmountHash = bn254.t4.permutation([0n, DOMAIN_TX_AMOUNT, txAmount, salt])[0];
  const merkleRoot = merkleRootPoseidon2(oldCommitment, pathElements, pathIndices);
  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

function stringify(witness) {
  const out = {};
  for (const [k, v] of Object.entries(witness)) {
    out[k] = Array.isArray(v) ? v.map(String) : String(v);
  }
  return out;
}

async function proveAndVerify(vk, witness) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(stringify(witness), WASM_PATH, ZKEY_PATH);
  const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
  return valid;
}

async function assertRejected(vk, witness, label) {
  let threw = false;
  try {
    await proveAndVerify(vk, witness);
  } catch {
    threw = true;
  }
  assert(threw, `${label}: proof generation must fail for a malicious witness`);
  console.log(`  PASS: ${label}`);
}

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const vk = JSON.parse(await (await import("fs/promises")).readFile(VK_PATH, "utf8"));

  console.log("=== transfer_poseidon2.circom negative tests (real Groth16 proofs) ===\n");

  const valid = buildValidWitness(poseidon, F);
  const okProof = await proveAndVerify(vk, valid);
  assert(okProof, "sanity: a correctly-derived witness must prove and verify");
  console.log("  PASS: N0 — valid witness proves and verifies (sanity check)");

  // N1: forged txAmountHash (attacker claims a different amount than they
  // actually committed to in the Poseidon2 sponge) — the in-circuit
  // `txAmountHash === txHash` assertion must catch this at witness time.
  await assertRejected(vk, { ...valid, txAmountHash: valid.txAmountHash + 1n },
    "N1 — forged txAmountHash rejected (Poseidon2 preimage mismatch)");

  // N2: tampered Merkle sibling — claims membership using a path that does
  // not actually hash (under Poseidon2) to the stated merkleRoot.
  const tamperedPath = [...valid.pathElements];
  tamperedPath[5] = tamperedPath[5] + 1n;
  await assertRejected(vk, { ...valid, pathElements: tamperedPath },
    "N2 — tampered Poseidon2 Merkle sibling rejected (root mismatch)");

  // N3: non-boolean pathIndices — a malicious prover tries an out-of-range
  // selector bit to see if the Poseidon2 MerkleProof mux constraint
  // (`pathIndices[i] * (1 - pathIndices[i]) === 0`) is actually enforced.
  const badIndices = [...valid.pathIndices];
  badIndices[0] = 2n;
  await assertRejected(vk, { ...valid, pathIndices: badIndices },
    "N3 — non-boolean pathIndices rejected (mux selector out of range)");

  // N4: wrong merkleRoot entirely (old commitment not actually in the tree).
  await assertRejected(vk, { ...valid, merkleRoot: valid.merkleRoot + 1n },
    "N4 — wrong merkleRoot rejected (commitment not in anonymity set)");

  console.log("\nAll negative tests passed — malicious witnesses are rejected.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Negative test suite failed:", err);
  process.exit(1);
});
