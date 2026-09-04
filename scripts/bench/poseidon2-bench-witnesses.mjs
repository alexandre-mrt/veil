/**
 * poseidon2-bench-witnesses.mjs — Witness builders for the six circuits/bench/*.circom
 * circuits (three hash "shapes" x {current, poseidon2}). Same constant values as
 * witnesses.mjs's buildTransferWitness/buildComplianceWitness/buildWithdrawWitness,
 * trimmed to each shape's actual signal set (no threshold/currentEpoch/requiredKycLevel/
 * validCredential — those belong to the arithmetic constraints the bench circuits drop).
 */
import { poseidon2CompressTagged, merkleRootPoseidon2 } from "./poseidon2-sponge.mjs";

const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n;
const DOMAIN_CONTEXT_BINDING = 6n;
const DOMAIN_WITHDRAW_NULLIFIER = 7n;
const DOMAIN_RECIPIENT_HASH = 8n;
const MERKLE_TAG = 9n;
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

// ─── transfer shape ─────────────────────────────────────────────────────────
export function buildTransferHashCurrentWitness(poseidon) {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  let merkleRoot = oldCommitment;
  for (let i = 0; i < MERKLE_DEPTH; i++) merkleRoot = toBI(poseidon([merkleRoot, 0n]));
  return {
    oldCommitment, newCommitment, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt, epochId,
    pathElements, pathIndices,
  };
}

export function buildTransferHashPoseidon2Witness() {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = poseidon2CompressTagged([cumulativeOld, randomnessOld, userSecret], 4, 1);
  const newCommitment = poseidon2CompressTagged([cumulativeNew, randomnessNew, userSecret], 4, 1);
  const nullifier = poseidon2CompressTagged([userSecret, epochId, randomnessOld], 4, 2);
  const txAmountHash = poseidon2CompressTagged([txAmount, salt], 3, 3);
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const merkleRoot = merkleRootPoseidon2(oldCommitment, pathElements, pathIndices, MERKLE_TAG);
  return {
    oldCommitment, newCommitment, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt, epochId,
    pathElements, pathIndices,
  };
}

// ─── compliance shape ───────────────────────────────────────────────────────
export function buildComplianceHashCurrentWitness(poseidon) {
  const userSecret = 987654321n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 42n;
  const transferNullifier = 111222333n;
  const credentialLeaf = toBI(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));
  const pathElements = [], pathIndices = [];
  let current = credentialLeaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    pathElements.push(0n);
    pathIndices.push(0n);
    current = toBI(poseidon([current, 0n]));
  }
  const merkleRoot = current;
  const contextId = toBI(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]));
  return {
    merkleRoot, contextId, nullifier,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
  };
}

export function buildComplianceHashPoseidon2Witness() {
  const userSecret = 987654321n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 42n;
  const transferNullifier = 111222333n;
  const credentialLeaf = poseidon2CompressTagged([userSecret, kycLevel, expiryEpoch, issuerId], 8, 4);
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const merkleRoot = merkleRootPoseidon2(credentialLeaf, pathElements, pathIndices, MERKLE_TAG);
  const contextId = poseidon2CompressTagged([transferNullifier, userSecret], 3, 6);
  const nullifier = poseidon2CompressTagged([userSecret, contextId], 3, 5);
  return {
    merkleRoot, contextId, nullifier,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
  };
}

// ─── withdraw shape ─────────────────────────────────────────────────────────
export function buildWithdrawHashCurrentWitness(poseidon) {
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xABCDEF123456n, randomnessNew = 77777n;
  const commitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, remainingBalance, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));
  const recipientHash = toBI(poseidon([DOMAIN_RECIPIENT_HASH, recipient]));
  return {
    commitment, nullifier, recipientHash, newCommitment,
    cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew, withdrawAmount,
  };
}

export function buildWithdrawHashPoseidon2Witness() {
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xABCDEF123456n, randomnessNew = 77777n;
  const commitment = poseidon2CompressTagged([cumulativeOld, randomnessOld, userSecret], 4, 1);
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = poseidon2CompressTagged([remainingBalance, randomnessNew, userSecret], 4, 1);
  const nullifier = poseidon2CompressTagged([userSecret, randomnessOld, cumulativeOld], 4, 7);
  const recipientHash = poseidon2CompressTagged([recipient], 2, 8);
  return {
    commitment, nullifier, recipientHash, newCommitment,
    cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew, withdrawAmount,
  };
}

export const BENCH_WITNESS_BUILDERS = {
  transfer_hash_current: (poseidon) => buildTransferHashCurrentWitness(poseidon),
  transfer_hash_poseidon2: () => buildTransferHashPoseidon2Witness(),
  compliance_hash_current: (poseidon) => buildComplianceHashCurrentWitness(poseidon),
  compliance_hash_poseidon2: () => buildComplianceHashPoseidon2Witness(),
  withdraw_hash_current: (poseidon) => buildWithdrawHashCurrentWitness(poseidon),
  withdraw_hash_poseidon2: () => buildWithdrawHashPoseidon2Witness(),
};

export function stringifyInputs(inputs) {
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  return out;
}
