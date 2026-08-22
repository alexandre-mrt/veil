/**
 * poseidon2-witnesses.mjs — valid-witness builders for the experimental
 * circuits/experiments/poseidon2/*.circom variants.
 *
 * Mirrors witnesses.mjs's builders exactly, EXCEPT for the specific hash
 * call sites each variant swapped to Poseidon2Hash (see
 * docs/research/2026-08-22-poseidon2-hash-swap.md for which sites, and why
 * only these): Merkle-path node hashes (t=3) and, for transfer/compliance,
 * the t=4 hashes (txAmountHash / compliance nullifier / context binding).
 * Everything else (t=5 commitment/nullifier hashes, t=6 credential leaf
 * hash) stayed on the original Poseidon and reuses the same values as
 * witnesses.mjs.
 */
import { bn254 } from "@taceo/poseidon2";

const DOMAIN_COMMITMENT = 1n;
const DOMAIN_TX_AMOUNT = 3n;
const DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n;
const DOMAIN_CONTEXT_BINDING = 6n;
const DOMAIN_WITHDRAW_NULLIFIER = 7n;
const DOMAIN_RECIPIENT_HASH = 8n;
const MERKLE_DEPTH = 20;

let poseidonF = null;
export function setPoseidonField(F) {
  poseidonF = F;
}
function toBI(val) {
  if (typeof val === "bigint") return val;
  if (poseidonF && val instanceof Uint8Array) return poseidonF.toObject(val);
  return BigInt(val);
}

/** Poseidon2Hash(2) sponge: state=[0,a,b], permute t=3, out=state[0]. Matches
 * circuits/templates/poseidon2_hash.circom exactly. */
function poseidon2Hash2(a, b) {
  return bn254.t3.permutation([0n, a, b])[0];
}
/** Poseidon2Hash(3) sponge: state=[0,a,b,c], permute t=4, out=state[0]. */
function poseidon2Hash3(a, b, c) {
  return bn254.t4.permutation([0n, a, b, c])[0];
}

function merkleRootFromPathPoseidon2(leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < pathElements.length; i++) {
    const sibling = pathElements[i];
    const [left, right] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = poseidon2Hash2(left, right);
  }
  return node;
}

export function buildTransferPoseidon2Witness(poseidon) {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  // Unchanged (original Poseidon): commitments + nullifier
  const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([2n, userSecret, epochId, randomnessOld]));
  // Swapped (Poseidon2): txAmountHash + Merkle path
  const txAmountHash = poseidon2Hash3(DOMAIN_TX_AMOUNT, txAmount, salt);
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const merkleRoot = merkleRootFromPathPoseidon2(oldCommitment, pathElements, pathIndices);
  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

export function buildWithdrawPoseidon2Witness(poseidon) {
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xABCDEF123456n, randomnessNew = 77777n;
  // Unchanged (original Poseidon): commitment, change commitment, nullifier
  const commitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, remainingBalance, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));
  // Swapped (Poseidon2): recipientHash
  const recipientHash = poseidon2Hash2(DOMAIN_RECIPIENT_HASH, recipient);
  return {
    commitment, withdrawAmount, nullifier, recipientHash, newCommitment,
    cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew,
  };
}

export function buildCompliancePoseidon2Witness(poseidon) {
  const userSecret = 987654321n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 42n;
  const currentEpoch = 500n, requiredKycLevel = 1n, transferNullifier = 111222333n;
  // Unchanged (original Poseidon): credential leaf (t=6, not swappable)
  const credentialLeaf = toBI(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));
  // Swapped (Poseidon2): Merkle path, context binding, nullifier
  const pathElements = [];
  const pathIndices = [];
  let current = credentialLeaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    pathElements.push(0n);
    pathIndices.push(0n);
    current = poseidon2Hash2(current, 0n);
  }
  const merkleRoot = current;
  const contextId = poseidon2Hash3(DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret);
  const nullifier = poseidon2Hash3(DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId);
  const expiryValid = expiryEpoch >= currentEpoch ? 1n : 0n;
  const kycValid = kycLevel >= requiredKycLevel ? 1n : 0n;
  const validCredential = expiryValid * kycValid;
  return {
    merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
  };
}

export const POSEIDON2_WITNESS_BUILDERS = {
  transfer: buildTransferPoseidon2Witness,
  withdraw: buildWithdrawPoseidon2Witness,
  compliance: buildCompliancePoseidon2Witness,
};

export function stringifyInputs(inputs) {
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  return out;
}
