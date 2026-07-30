/**
 * witnesses-v2.mjs — Valid-witness builders for the Poseidon2-Merkle-hash experiment
 * (transfer_v2.circom, compliance_v2.circom — see docs/research/2026-07-30-poseidon2-merkle-hash.md).
 *
 * Identical field values to witnesses.mjs (same domain tags, same test fixture numbers) so the
 * only thing that differs between the baseline and v2 proving-time benchmark is the Merkle-path
 * hash function. merkleRootFromPathV2 uses Poseidon2Hash2's exact convention: state = [0, left,
 * right], apply the Poseidon2(t=3) permutation, output state[0] — matching
 * circuits/lib/poseidon2/poseidon2_hash2.circom.
 */
import { bn254 } from "@taceo/poseidon2";

const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n;
const DOMAIN_CONTEXT_BINDING = 6n;
const MERKLE_DEPTH = 20;

function poseidon2Hash2(left, right) {
  const state = bn254.t3.permutation([0n, left, right]);
  return state[0];
}

function merkleRootFromPathV2(leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < pathElements.length; i++) {
    const sibling = pathElements[i];
    const [left, right] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = poseidon2Hash2(left, right);
  }
  return node;
}

export function buildTransferV2Witness(poseidon) {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = poseidon.F.toObject(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = poseidon.F.toObject(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = poseidon.F.toObject(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const txAmountHash = poseidon.F.toObject(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const merkleRoot = merkleRootFromPathV2(oldCommitment, pathElements, pathIndices);
  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

export function buildComplianceV2Witness(poseidon) {
  const userSecret = 987654321n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 42n;
  const currentEpoch = 500n, requiredKycLevel = 1n, transferNullifier = 111222333n;
  const credentialLeaf = poseidon.F.toObject(
    poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId])
  );
  const pathElements = [];
  const pathIndices = [];
  let current = credentialLeaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    pathElements.push(0n);
    pathIndices.push(0n);
    current = poseidon2Hash2(current, 0n);
  }
  const merkleRoot = current;
  const contextId = poseidon.F.toObject(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]));
  const nullifier = poseidon.F.toObject(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]));
  const expiryValid = expiryEpoch >= currentEpoch ? 1n : 0n;
  const kycValid = kycLevel >= requiredKycLevel ? 1n : 0n;
  const validCredential = expiryValid * kycValid;
  return {
    merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
  };
}

export const WITNESS_BUILDERS_V2 = {
  transfer_v2: buildTransferV2Witness,
  compliance_v2: buildComplianceV2Witness,
};

export function stringifyInputs(inputs) {
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  return out;
}
