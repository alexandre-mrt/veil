/**
 * witnesses-poseidon2.mjs — Valid-witness builders for the Poseidon2 experiment circuits
 * (circuits/experiments/poseidon2/{transfer2,compliance2,withdraw2}.circom).
 *
 * Field-for-field identical to scripts/bench/witnesses.mjs's builders (same values, same domain
 * tags, same structure) — the only difference is which hash function computes the derived public
 * inputs (oldCommitment, nullifier, merkleRoot, ...): here it's the Poseidon2 sponge/compression
 * wrappers the experiment circuits use, instead of circomlib's classic Poseidon.
 *
 * poseidon2Hash() and poseidon2MerkleStep() reimplement, in JS, exactly what
 * circuits/experiments/poseidon2/templates/poseidon2_hash.circom and merkle_proof2.circom compute
 * in-circuit, using @taceo/poseidon2's raw permutation (bn254.tN.permutation) as the primitive.
 * That JS permutation was cross-checked byte-for-byte against the circom Poseidon2(t) component's
 * own witness output before being relied on here (see the experiment report, "Approach") — without
 * that check, a mismatched round-constant table would silently produce a witness the circuit
 * rejects, not a wrong-but-plausible one, so it fails loudly rather than being a source of doubt.
 */
import { bn254 } from "@taceo/poseidon2";

const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const DOMAIN_CREDENTIAL_LEAF = 4n;
const DOMAIN_COMPLIANCE_NULLIFIER = 5n;
const DOMAIN_CONTEXT_BINDING = 6n;
const DOMAIN_WITHDRAW_NULLIFIER = 7n;
const DOMAIN_RECIPIENT_HASH = 8n;
const MERKLE_DEPTH = 20;

function poseidon2Width(nInputs) {
  if (nInputs <= 1) return 2;
  if (nInputs <= 2) return 3;
  if (nInputs <= 3) return 4;
  if (nInputs <= 7) return 8;
  if (nInputs <= 11) return 12;
  return 16;
}

const PERM_BY_WIDTH = { 2: bn254.t2, 3: bn254.t3, 4: bn254.t4, 8: bn254.t8, 12: bn254.t12, 16: bn254.t16 };

/** Mirrors templates/poseidon2_hash.circom's Poseidon2Hash(nInputs): sponge, ds=0, single block. */
export function poseidon2Hash(inputs) {
  const n = inputs.length;
  const t = poseidon2Width(n);
  const state = new Array(t).fill(0n);
  for (let i = 0; i < n; i++) state[i] = inputs[i];
  state[t - 1] = 0n; // ds = 0
  const out = PERM_BY_WIDTH[t].permutation(state);
  return out[0];
}

/** Mirrors templates/merkle_proof2.circom's per-level step: t=2 compression + Miyaguchi-Preneel. */
export function poseidon2MerkleStep(left, right) {
  const out = bn254.t2.permutation([left, right]);
  return (out[0] + left) % FIELD_MODULUS;
}

function merkleRootFromPath(leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < pathElements.length; i++) {
    const sibling = pathElements[i];
    const [left, right] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = poseidon2MerkleStep(left, right);
  }
  return node;
}

export function buildTransfer2Witness() {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = poseidon2Hash([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]);
  const newCommitment = poseidon2Hash([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]);
  const nullifier = poseidon2Hash([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]);
  const txAmountHash = poseidon2Hash([DOMAIN_TX_AMOUNT, txAmount, salt]);
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const merkleRoot = merkleRootFromPath(oldCommitment, pathElements, pathIndices);
  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

export function buildWithdraw2Witness() {
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xABCDEF123456n, randomnessNew = 77777n;
  const commitment = poseidon2Hash([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]);
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = poseidon2Hash([DOMAIN_COMMITMENT, remainingBalance, randomnessNew, userSecret]);
  const nullifier = poseidon2Hash([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]);
  const recipientHash = poseidon2Hash([DOMAIN_RECIPIENT_HASH, recipient]);
  return {
    commitment, withdrawAmount, nullifier, recipientHash, newCommitment,
    cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew,
  };
}

export function buildCompliance2Witness() {
  const userSecret = 987654321n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 42n;
  const currentEpoch = 500n, requiredKycLevel = 1n, transferNullifier = 111222333n;
  const credentialLeaf = poseidon2Hash([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]);
  const pathElements = [];
  const pathIndices = [];
  let current = credentialLeaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    pathElements.push(0n);
    pathIndices.push(0n);
    current = poseidon2MerkleStep(current, 0n);
  }
  const merkleRoot = current;
  const contextId = poseidon2Hash([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]);
  const nullifier = poseidon2Hash([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]);
  const expiryValid = expiryEpoch >= currentEpoch ? 1n : 0n;
  const kycValid = kycLevel >= requiredKycLevel ? 1n : 0n;
  const validCredential = expiryValid * kycValid;
  return {
    merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
  };
}

export const WITNESS_BUILDERS_POSEIDON2 = {
  transfer2: buildTransfer2Witness,
  withdraw2: buildWithdraw2Witness,
  compliance2: buildCompliance2Witness,
};

export function stringifyInputs(inputs) {
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  return out;
}
