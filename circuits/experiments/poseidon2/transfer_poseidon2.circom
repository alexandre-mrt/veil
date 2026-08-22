pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";
include "../../templates/merkle_proof_poseidon2.circom";
include "../../templates/poseidon2_hash.circom";

// EXPERIMENTAL variant of ../../transfer.circom — see
// docs/research/2026-08-22-poseidon2-hash-swap.md. NOT wired into the pool
// (contracts/), NOT a drop-in replacement for transfer.circom.
//
// Swapped to Poseidon2 (verified round constants exist at these widths):
//   - C0: Merkle membership node hash, Poseidon(2)/t=3 -> Poseidon2Hash(2), x20
//   - C11: txAmountHash, Poseidon(3)/t=4 -> Poseidon2Hash(3)
//
// Left UNCHANGED on the original Poseidon (no audited t=5 Poseidon2 BN254
// round constants were found in any reachable package this session):
//   - C1/C2: oldCommitment/newCommitment, Poseidon(4)/t=5
//   - C10: nullifier, Poseidon(4)/t=5
//
// All other constraints (C3-C9) are unchanged arithmetic/range checks, copied
// verbatim from transfer.circom.
template TransferPoseidon2() {
    // ─── PUBLIC INPUTS (7 total — order matters for Sui on-chain verification) ───
    signal input oldCommitment;    // Poseidon(1, cumulativeOld, randomnessOld, userSecret)
    signal input newCommitment;    // Poseidon(1, cumulativeNew, randomnessNew, userSecret)
    signal input threshold;        // KYC-free epoch limit
    signal input epochId;          // Current epoch identifier (from on-chain Clock)
    signal input nullifier;        // Poseidon(2, userSecret, epochId, randomnessOld)
    signal input txAmountHash;     // Poseidon2(3, txAmount, salt) — domain-separated
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

    // ─── C0: Old commitment is in the Merkle tree (Poseidon2 node hash) ─────
    component membershipProof = Poseidon2MerkleProof(20);
    membershipProof.leaf <== oldCommitment;
    for (var i = 0; i < 20; i++) {
        membershipProof.pathElements[i] <== pathElements[i];
        membershipProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === membershipProof.root;

    // ─── C1: Old commitment is well-formed (unchanged: Poseidon(4), t=5) ────
    component oldHash = Poseidon(4);
    oldHash.inputs[0] <== 1;
    oldHash.inputs[1] <== cumulativeOld;
    oldHash.inputs[2] <== randomnessOld;
    oldHash.inputs[3] <== userSecret;
    oldCommitment === oldHash.out;

    // ─── C2: New commitment is well-formed (unchanged: Poseidon(4), t=5) ────
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

    // ─── C10: Nullifier is correctly derived (unchanged: Poseidon(4), t=5) ──
    component nfHash = Poseidon(4);
    nfHash.inputs[0] <== 2;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== epochId;
    nfHash.inputs[3] <== randomnessOld;
    nullifier === nfHash.out;

    // ─── C11: tx amount hash (Poseidon2Hash(3), t=4) ─────────────────────────
    component txHash = Poseidon2Hash(3);
    txHash.inputs[0] <== 3;
    txHash.inputs[1] <== txAmount;
    txHash.inputs[2] <== salt;
    txAmountHash === txHash.out;
}

component main {public [oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot]} = TransferPoseidon2();
