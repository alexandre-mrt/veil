// witness-inputs.mjs — builds valid witnesses for Veil's three circuits, using the
// same commitment/nullifier/domain-tag formulas as circuits/test/*.test.mjs and
// docs/SPEC.md. Shared by groth16-bench.mjs (Node) and browser-harness (real WASM
// in Chromium) so both benchmarks prove the exact same statement.

const MERKLE_DEPTH = 20;

function toBI(F, val) {
  return typeof val === "bigint" ? val : F.toObject(val);
}

function merkleRoot(F, poseidon, leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    const sibling = pathElements[i];
    const [l, r] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = toBI(F, poseidon([l, r]));
  }
  return node;
}

export function buildTransferInput(F, poseidon) {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = toBI(F, poseidon([1n, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(F, poseidon([1n, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(F, poseidon([2n, userSecret, epochId, randomnessOld]));
  const txAmountHash = toBI(F, poseidon([3n, txAmount, salt]));
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const root = merkleRoot(F, poseidon, oldCommitment, pathElements, pathIndices);
  return {
    oldCommitment: oldCommitment.toString(), newCommitment: newCommitment.toString(),
    threshold: threshold.toString(), epochId: epochId.toString(), nullifier: nullifier.toString(),
    txAmountHash: txAmountHash.toString(), merkleRoot: root.toString(),
    cumulativeOld: cumulativeOld.toString(), cumulativeNew: cumulativeNew.toString(),
    txAmount: txAmount.toString(), randomnessOld: randomnessOld.toString(),
    randomnessNew: randomnessNew.toString(), userSecret: userSecret.toString(), salt: salt.toString(),
    pathElements: pathElements.map(String), pathIndices: pathIndices.map(String),
  };
}

export function buildComplianceInput(F, poseidon) {
  const userSecret = 555n, kycLevel = 2n, expiryEpoch = 1000n, issuerId = 7n;
  const currentEpoch = 1n, requiredKycLevel = 1n, transferNullifier = 42n;
  const leaf = toBI(F, poseidon([4n, userSecret, kycLevel, expiryEpoch, issuerId]));
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const root = merkleRoot(F, poseidon, leaf, pathElements, pathIndices);
  const contextId = toBI(F, poseidon([6n, transferNullifier, userSecret]));
  const nullifier = toBI(F, poseidon([5n, userSecret, contextId]));
  return {
    merkleRoot: root.toString(), currentEpoch: currentEpoch.toString(), contextId: contextId.toString(),
    requiredKycLevel: requiredKycLevel.toString(), nullifier: nullifier.toString(), validCredential: "1",
    userSecret: userSecret.toString(), kycLevel: kycLevel.toString(), expiryEpoch: expiryEpoch.toString(),
    issuerId: issuerId.toString(), pathElements: pathElements.map(String), pathIndices: pathIndices.map(String),
    transferNullifier: transferNullifier.toString(),
  };
}

export function buildWithdrawInput(F, poseidon) {
  const cumulativeOld = 500n, randomnessOld = 11n, userSecret = 777n, recipient = 999888777n, randomnessNew = 22n;
  const withdrawAmount = 200n;
  const commitment = toBI(F, poseidon([1n, cumulativeOld, randomnessOld, userSecret]));
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = toBI(F, poseidon([1n, remainingBalance, randomnessNew, userSecret]));
  const nullifier = toBI(F, poseidon([7n, userSecret, randomnessOld, cumulativeOld]));
  const recipientHash = toBI(F, poseidon([8n, recipient]));
  return {
    commitment: commitment.toString(), withdrawAmount: withdrawAmount.toString(), nullifier: nullifier.toString(),
    recipientHash: recipientHash.toString(), newCommitment: newCommitment.toString(),
    cumulativeOld: cumulativeOld.toString(), randomnessOld: randomnessOld.toString(),
    userSecret: userSecret.toString(), recipient: recipient.toString(), randomnessNew: randomnessNew.toString(),
  };
}
