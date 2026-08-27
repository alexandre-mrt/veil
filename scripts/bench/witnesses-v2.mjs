/**
 * witnesses-v2.mjs — Valid-witness builders for circuits/bench/poseidon2/full/{transfer,withdraw,compliance}_v2.circom.
 *
 * Same field names, same numeric fixtures as scripts/bench/witnesses.mjs, so the two are a fair
 * apples-to-apples pair — only the hash function differs (poseidon2Sponge instead of circomlib's
 * Poseidon). compliance_v2's credential-leaf hash (C1) is unchanged (still circomlib Poseidon(5) —
 * see compliance_v2.circom's header for why), so it uses circomlibjs's poseidon there, matching
 * witnesses.mjs exactly for that one hash.
 */
import { poseidon2Sponge } from "./poseidon2-sponge.mjs";

const MERKLE_DEPTH = 20;

function merkleRootFromPathV2(leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < pathElements.length; i++) {
    const sibling = pathElements[i];
    const [left, right] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = poseidon2Sponge([left, right], 3, 0);
  }
  return node;
}

export function buildTransferWitnessV2() {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = poseidon2Sponge([cumulativeOld, randomnessOld, userSecret], 4, 1);
  const newCommitment = poseidon2Sponge([cumulativeNew, randomnessNew, userSecret], 4, 1);
  const nullifier = poseidon2Sponge([userSecret, epochId, randomnessOld], 4, 2);
  const txAmountHash = poseidon2Sponge([txAmount, salt], 3, 3);
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const merkleRoot = merkleRootFromPathV2(oldCommitment, pathElements, pathIndices);
  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

export function buildWithdrawWitnessV2() {
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xABCDEF123456n, randomnessNew = 77777n;
  const commitment = poseidon2Sponge([cumulativeOld, randomnessOld, userSecret], 4, 1);
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = poseidon2Sponge([remainingBalance, randomnessNew, userSecret], 4, 1);
  const nullifier = poseidon2Sponge([userSecret, randomnessOld, cumulativeOld], 4, 7);
  const recipientHash = poseidon2Sponge([recipient], 2, 8);
  return {
    commitment, withdrawAmount, nullifier, recipientHash, newCommitment,
    cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew,
  };
}

export function buildComplianceWitnessV2(poseidonOld, poseidonOldF) {
  const toBI = (v) => (typeof v === "bigint" ? v : poseidonOldF.toObject(v));
  const userSecret = 987654321n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 42n;
  const currentEpoch = 500n, requiredKycLevel = 1n, transferNullifier = 111222333n;
  // C1 unchanged: still circomlib Poseidon(5), matching compliance_v2.circom
  const credentialLeaf = toBI(poseidonOld([4n, userSecret, kycLevel, expiryEpoch, issuerId]));
  const pathElements = [];
  const pathIndices = [];
  let current = credentialLeaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    pathElements.push(0n);
    pathIndices.push(0n);
    current = poseidon2Sponge([current, 0n], 3, 0);
  }
  const merkleRoot = current;
  const contextId = poseidon2Sponge([transferNullifier, userSecret], 3, 6);
  const nullifier = poseidon2Sponge([userSecret, contextId], 3, 5);
  const expiryValid = expiryEpoch >= currentEpoch ? 1n : 0n;
  const kycValid = kycLevel >= requiredKycLevel ? 1n : 0n;
  const validCredential = expiryValid * kycValid;
  return {
    merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
  };
}

export function stringifyInputs(inputs) {
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  return out;
}
