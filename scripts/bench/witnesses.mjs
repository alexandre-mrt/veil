/**
 * witnesses.mjs — Shared valid-witness builders for Veil's three circuits.
 *
 * Mirrors buildValidWitness() in circuits/test/{transfer,withdraw,compliance}.test.mjs exactly
 * (same domain tags, same field names) so bench proofs exercise the real constraint set.
 * Used by both prove-latency.mjs (Node) and browser-latency.mjs (Chromium, via witness JSON
 * computed at request time — see serveWitness()).
 */
const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
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

function merkleRootFromPath(poseidon, leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < pathElements.length; i++) {
    const sibling = pathElements[i];
    const [left, right] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = toBI(poseidon([left, right]));
  }
  return node;
}

// Optional `o` overrides let a bench pin the epoch, user, or Merkle path without forking the builder.
export function buildTransferWitness(poseidon, o = {}) {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = o.randomnessOld ?? 0n, randomnessNew = 12345n;
  const userSecret = o.userSecret ?? 987654321n, epochId = o.epochId ?? 1n;
  const threshold = o.threshold ?? 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
  const pathElements = o.pathElements ?? Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = o.pathIndices ?? Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const merkleRoot = merkleRootFromPath(poseidon, oldCommitment, pathElements, pathIndices);
  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

export function buildWithdrawWitness(poseidon, o = {}) {
  const cumulativeOld = 500n, randomnessOld = o.randomnessOld ?? 12345n, userSecret = o.userSecret ?? 987654321n;
  const withdrawAmount = 100n, recipient = o.recipient ?? 0xABCDEF123456n, randomnessNew = o.randomnessNew ?? 77777n;
  const commitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, remainingBalance, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_WITHDRAW_NULLIFIER, userSecret, randomnessOld, cumulativeOld]));
  const recipientHash = toBI(poseidon([DOMAIN_RECIPIENT_HASH, recipient]));
  return {
    commitment, withdrawAmount, nullifier, recipientHash, newCommitment,
    cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew,
  };
}

export function buildComplianceWitness(poseidon, o = {}) {
  const userSecret = 987654321n, kycLevel = 2n, issuerId = 42n;
  const currentEpoch = o.currentEpoch ?? 500n, expiryEpoch = o.expiryEpoch ?? 1000n;
  const requiredKycLevel = 1n, transferNullifier = o.transferNullifier ?? 111222333n;
  const credentialLeaf = toBI(poseidon([DOMAIN_CREDENTIAL_LEAF, userSecret, kycLevel, expiryEpoch, issuerId]));
  const pathElements = [];
  const pathIndices = [];
  let current = credentialLeaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    pathElements.push(0n);
    pathIndices.push(0n);
    current = toBI(poseidon([current, 0n]));
  }
  const merkleRoot = current;
  const contextId = toBI(poseidon([DOMAIN_CONTEXT_BINDING, transferNullifier, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_COMPLIANCE_NULLIFIER, userSecret, contextId]));
  const expiryValid = expiryEpoch >= currentEpoch ? 1n : 0n;
  const kycValid = kycLevel >= requiredKycLevel ? 1n : 0n;
  const validCredential = expiryValid * kycValid;
  return {
    merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential,
    userSecret, kycLevel, expiryEpoch, issuerId, pathElements, pathIndices, transferNullifier,
  };
}

export const WITNESS_BUILDERS = {
  transfer: buildTransferWitness,
  withdraw: buildWithdrawWitness,
  compliance: buildComplianceWitness,
};

export function stringifyInputs(inputs) {
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  return out;
}
