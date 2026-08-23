/**
 * witness-transfer-poseidon2.mjs — Witness builder for circuits/forked/transfer_poseidon2.circom.
 *
 * Same numeric values as buildTransferWitness() in scripts/bench/witnesses.mjs (the production
 * transfer.circom witness) — cumulativeOld=0, txAmount=100, randomnessOld=0, randomnessNew=12345,
 * userSecret=987654321, epochId=1, threshold=1_000_000_000, salt=99, empty (all-zero) 20-level
 * Merkle path — so the only variable between the two witnesses is the hash function computing
 * commitments/nullifier/txAmountHash/merkleRoot from those same values. Domain tags are placed
 * in the capacity element (see circuits/lib/poseidon2_hash.circom), not the rate, matching the
 * production circuit's tag *values* (1 = commitment, 2 = nullifier, 3 = tx-amount) but not its
 * rate-element placement.
 */
import { bn254 } from "@taceo/poseidon2";

const MERKLE_DEPTH = 20;

function poseidon2Hash(msg, T, ds) {
  const state = new Array(T).fill(0n);
  state[0] = ds;
  for (let i = 0; i < msg.length; i++) state[i + 1] = msg[i];
  const key = `t${T}`;
  return bn254[key].permutation(state)[0];
}

function compress2(left, right) {
  return poseidon2Hash([left, right], 3, 0n);
}

function merkleRootFromPath(leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < pathElements.length; i++) {
    const sibling = pathElements[i];
    const [left, right] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = compress2(left, right);
  }
  return node;
}

export function buildTransferPoseidon2Witness() {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;

  const oldCommitment = poseidon2Hash([cumulativeOld, randomnessOld, userSecret], 4, 1n);
  const newCommitment = poseidon2Hash([cumulativeNew, randomnessNew, userSecret], 4, 1n);
  const nullifier = poseidon2Hash([userSecret, epochId, randomnessOld], 4, 2n);
  const txAmountHash = poseidon2Hash([txAmount, salt], 3, 3n);

  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const merkleRoot = merkleRootFromPath(oldCommitment, pathElements, pathIndices);

  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

export function buildWithdrawPoseidon2Witness() {
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xABCDEF123456n, randomnessNew = 77777n;
  const commitment = poseidon2Hash([cumulativeOld, randomnessOld, userSecret], 4, 1n);
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = poseidon2Hash([remainingBalance, randomnessNew, userSecret], 4, 1n);
  const nullifier = poseidon2Hash([userSecret, randomnessOld, cumulativeOld], 4, 7n);
  const recipientHash = poseidon2Hash([recipient], 2, 8n);
  return {
    commitment, withdrawAmount, nullifier, recipientHash, newCommitment,
    cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew,
  };
}

export function stringifyInputs(inputs) {
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  return out;
}
