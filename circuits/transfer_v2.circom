pragma circom 2.1.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "templates/merkle_proof_v2.circom";

// EXPERIMENTAL (docs/research/2026-07-30-poseidon2-merkle-hash.md): identical to
// transfer.circom except the depth-20 Merkle-path hasher is MerkleProofV2 (Poseidon2
// permutation) instead of MerkleProof (circomlib Poseidon). Every other constraint,
// domain tag, and public/private input is unchanged. Not wired into any deployed VK.
//
// Transfer circuit for Veil privacy protocol (v2 — audit fixes).
//
// Proves that a cumulative spending update is valid:
// - Old and new commitments are well-formed and bound to userSecret
// - New cumulative = old cumulative + tx amount
// - tx amount > 0
// - All values fit in 64 bits (no overflow)
// - Nullifier is unique per transfer (not per epoch)
// - tx amount hash has domain separation
//
// Domain separation tags (first Poseidon input):
//   1 → commitment hash  H(1, cumulative, randomness, userSecret)
//   2 → nullifier hash   H(2, userSecret, epochId, randomnessOld)
//   3 → txAmountHash     H(3, txAmount, salt)
//
// Audit fixes applied:
//   CRYPTO-004: Commitment bound to userSecret (Poseidon(4))
//   CRYPTO-006: Note-based nullifier with randomnessOld (multiple txs per epoch)
//   CRYPTO-011: txAmountHash domain tag 3 (Poseidon(3))
//
// Curve: BN254 (Groth16, Sui curve id 1)
// Compiled with circom 2.1.x, proven with snarkjs 0.7.x

template Transfer() {
    // ─── PUBLIC INPUTS (7 total — order matters for Sui on-chain verification) ───
    signal input oldCommitment;    // Poseidon(1, cumulativeOld, randomnessOld, userSecret)
    signal input newCommitment;    // Poseidon(1, cumulativeNew, randomnessNew, userSecret)
    signal input threshold;        // KYC-free epoch limit
    signal input epochId;          // Current epoch identifier (from on-chain Clock)
    signal input nullifier;        // Poseidon(2, userSecret, epochId, randomnessOld)
    signal input txAmountHash;     // Poseidon(3, txAmount, salt) — domain-separated
    signal input merkleRoot;       // Commitment Merkle tree root (anonymity set = all commitments)

    // ─── PRIVATE INPUTS (7 + Merkle path) ───────────────────────────────────
    signal input cumulativeOld;    // Previous cumulative spending this epoch
    signal input cumulativeNew;    // cumulativeOld + txAmount
    signal input txAmount;         // This transaction's amount
    signal input randomnessOld;    // Blinding factor for oldCommitment
    signal input randomnessNew;    // Blinding factor for newCommitment
    signal input userSecret;       // User's master secret (never revealed)
    signal input salt;             // Salt for txAmountHash
    signal input pathElements[20]; // Merkle sibling hashes (depth 20)
    signal input pathIndices[20];  // Left/right flags (0 or 1)

    // ─── C0: Old commitment is in the Merkle tree (anonymity set proof) ─────
    // Proves membership without revealing which leaf — observer sees root update
    // but NOT which commitment was consumed. Same template as compliance.circom.
    component membershipProof = MerkleProofV2(20);
    membershipProof.leaf <== oldCommitment;
    for (var i = 0; i < 20; i++) {
        membershipProof.pathElements[i] <== pathElements[i];
        membershipProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === membershipProof.root;

    // ─── C1: Old commitment is well-formed ───────────────────────────────────
    // oldCommitment = Poseidon(1, cumulativeOld, randomnessOld, userSecret)
    // CRYPTO-004 fix: commitment bound to userSecret
    component oldHash = Poseidon(4);
    oldHash.inputs[0] <== 1;
    oldHash.inputs[1] <== cumulativeOld;
    oldHash.inputs[2] <== randomnessOld;
    oldHash.inputs[3] <== userSecret;
    oldCommitment === oldHash.out;

    // ─── C2: New commitment is well-formed ───────────────────────────────────
    // newCommitment = Poseidon(1, cumulativeNew, randomnessNew, userSecret)
    component newHash = Poseidon(4);
    newHash.inputs[0] <== 1;
    newHash.inputs[1] <== cumulativeNew;
    newHash.inputs[2] <== randomnessNew;
    newHash.inputs[3] <== userSecret;
    newCommitment === newHash.out;

    // ─── C3: Cumulative update is correct ────────────────────────────────────
    cumulativeNew === cumulativeOld + txAmount;

    // ─── C4: txAmount > 0 ────────────────────────────────────────────────────
    component gtZero = GreaterThan(64);
    gtZero.in[0] <== txAmount;
    gtZero.in[1] <== 0;
    gtZero.out === 1;

    // ─── C5-C7: Range proofs [0, 2^64) ──────────────────────────────────────
    component oldBits = Num2Bits(64);
    oldBits.in <== cumulativeOld;

    component txBits = Num2Bits(64);
    txBits.in <== txAmount;

    component newBits = Num2Bits(64);
    newBits.in <== cumulativeNew;

    // ─── C8: Threshold range proof ───────────────────────────────────────────
    component threshBits = Num2Bits(64);
    threshBits.in <== threshold;

    // ─── C9: Cumulative spending under threshold ─────────────────────────────
    component ltThreshold = LessEqThan(64);
    ltThreshold.in[0] <== cumulativeNew;
    ltThreshold.in[1] <== threshold;
    ltThreshold.out === 1;

    // ─── C10: Nullifier is correctly derived ─────────────────────────────────
    // nullifier = Poseidon(2, userSecret, epochId, randomnessOld)
    // CRYPTO-006 fix: randomnessOld makes nullifier unique per transfer,
    // allowing multiple transfers per epoch
    component nfHash = Poseidon(4);
    nfHash.inputs[0] <== 2;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== epochId;
    nfHash.inputs[3] <== randomnessOld;
    nullifier === nfHash.out;

    // ─── C11: tx amount hash is correctly derived ────────────────────────────
    // txAmountHash = Poseidon(3, txAmount, salt)
    // CRYPTO-011 fix: domain tag 3 for domain separation
    component txHash = Poseidon(3);
    txHash.inputs[0] <== 3;
    txHash.inputs[1] <== txAmount;
    txHash.inputs[2] <== salt;
    txAmountHash === txHash.out;
}

component main {public [oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot]} = Transfer();
