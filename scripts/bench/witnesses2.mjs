/**
 * witnesses2.mjs — Valid-witness builders for the Poseidon2 shadow circuits
 * (transfer2/withdraw2/compliance2.circom), mirroring witnesses.mjs's inputs
 * exactly (same values, same domain tags) so the Poseidon1-vs-Poseidon2
 * benchmark proves semantically equivalent statements. Only the hash
 * primitive differs: domain tags move from "first Poseidon input" to the
 * sponge's capacity element (DS), per each shadow circuit's header comment.
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

const PERM = { 2: bn254.t2, 3: bn254.t3, 4: bn254.t4, 8: bn254.t8 };

// Mirrors Poseidon2SpongeWithDs in @taceo/circom-lib's compression.circom:
// state = zeros with DS in the last (capacity) slot, absorb `data` in
// chunks of size T-1, permute after each chunk, output = state[0].
// All of Veil's shadow-circuit hashes fit in a single permutation (data
// length <= T-1), matching how the circuits above call it.
function spongeWithDs(data, t, ds) {
  const rate = t - 1;
  let state = new Array(t).fill(0n);
  state[t - 1] = ds;
  for (let offset = 0; offset < data.length; offset += rate) {
    const chunk = data.slice(offset, offset + rate);
    for (let i = 0; i < chunk.length; i++) {
      state[i] = (state[i] + chunk[i]) % FIELD_MODULUS;
    }
    state = PERM[t].permutation(state);
  }
  return state[0];
}

// Mirrors TACEO_PRECOMPUTATION_Poseidon2(2) compression mode used by
// merkle_proof2.circom: out = perm([a,b])[0] + a (Miyaguchi-Preneel).
function compress2(a, b) {
  const perm = bn254.t2.permutation([a, b]);
  return (perm[0] + a) % FIELD_MODULUS;
}

function merkleRootFromPath2(leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < pathElements.length; i++) {
    const sibling = pathElements[i];
    const [left, right] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = compress2(left, right);
  }
  return node;
}

export function buildTransfer2Witness() {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = spongeWithDs([cumulativeOld, randomnessOld, userSecret], 4, DOMAIN_COMMITMENT);
  const newCommitment = spongeWithDs([cumulativeNew, randomnessNew, userSecret], 4, DOMAIN_COMMITMENT);
  const nullifier = spongeWithDs([userSecret, epochId, randomnessOld], 4, DOMAIN_NULLIFIER);
  const txAmountHash = spongeWithDs([txAmount, salt], 3, DOMAIN_TX_AMOUNT);
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const merkleRoot = merkleRootFromPath2(oldCommitment, pathElements, pathIndices);
  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

export function buildWithdraw2Witness() {
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xABCDEF123456n, randomnessNew = 77777n;
  const commitment = spongeWithDs([cumulativeOld, randomnessOld, userSecret], 4, DOMAIN_COMMITMENT);
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = spongeWithDs([remainingBalance, randomnessNew, userSecret], 4, DOMAIN_COMMITMENT);
  const nullifier = spongeWithDs([userSecret, randomnessOld, cumulativeOld], 4, DOMAIN_WITHDRAW_NULLIFIER);
  const recipientHash = spongeWithDs([recipient], 2, DOMAIN_RECIPIENT_HASH);
  return {
    commitment, withdrawAmount, nullifier, recipientHash, newCommitment,
    cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew,
  };
}

export function buildCompliance2Witness() {
  const userSecret = 987654321n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 42n;
  const currentEpoch = 500n, requiredKycLevel = 1n, transferNullifier = 111222333n;
  const credentialLeaf = spongeWithDs([userSecret, kycLevel, expiryEpoch, issuerId], 8, DOMAIN_CREDENTIAL_LEAF);
  const pathElements = [];
  const pathIndices = [];
  let current = credentialLeaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    pathElements.push(0n);
    pathIndices.push(0n);
    current = compress2(current, 0n);
  }
  const merkleRoot = current;
  const contextId = spongeWithDs([transferNullifier, userSecret], 3, DOMAIN_CONTEXT_BINDING);
  const nullifier = spongeWithDs([userSecret, contextId], 3, DOMAIN_COMPLIANCE_NULLIFIER);
  const expiryValid = expiryEpoch >= currentEpoch ? 1n : 0n;
  const kycValid = kycLevel >= requiredKycLevel ? 1n : 0n;
  const validCredential = expiryValid * kycValid;
  return {
    merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
  };
}

export const WITNESS_BUILDERS_V2 = {
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
