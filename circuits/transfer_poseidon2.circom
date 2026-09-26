pragma circom 2.1.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "templates/merkle_proof_poseidon2.circom";

// transfer_poseidon2.circom — research variant of transfer.circom for
// docs/research/2026-09-26-poseidon2-merkle-path.md.
//
// Identical to transfer.circom in every constraint EXCEPT C0: the depth-20
// Merkle membership check uses MerkleProofPoseidon2 (Poseidon2 compression,
// see templates/merkle_proof_poseidon2.circom) instead of MerkleProof
// (circomlib Poseidon(2) sponge). C1–C11 — commitments, nullifier,
// txAmountHash, range checks, threshold check — are byte-for-byte the same
// as transfer.circom. This isolates the Merkle-path hash swap as the only
// variable, so the constraint-count and proving-time diff against
// transfer.circom is attributable to that one change.
//
// NOT wired into pool.move, the frontend, or any other production path.
// Measurement-only. See the research report for the soundness argument,
// leakage analysis, and negative tests before this could ever be considered
// for production use.
//
// Curve: BN254 (Groth16, Sui curve id 1)
// Compiled with circom 2.2.x, proven with snarkjs 0.7.x

template TransferPoseidon2() {
    // ─── PUBLIC INPUTS (7 total — same order as transfer.circom) ───
    signal input oldCommitment;
    signal input newCommitment;
    signal input threshold;
    signal input epochId;
    signal input nullifier;
    signal input txAmountHash;
    signal input merkleRoot;

    // ─── PRIVATE INPUTS (7 + Merkle path) ───────────────────────────────────
    signal input cumulativeOld;
    signal input cumulativeNew;
    signal input txAmount;
    signal input randomnessOld;
    signal input randomnessNew;
    signal input userSecret;
    signal input salt;
    signal input pathElements[20];
    signal input pathIndices[20];

    // ─── C0: Old commitment is in the Merkle tree — Poseidon2 variant ───────
    component membershipProof = MerkleProofPoseidon2(20);
    membershipProof.leaf <== oldCommitment;
    for (var i = 0; i < 20; i++) {
        membershipProof.pathElements[i] <== pathElements[i];
        membershipProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === membershipProof.root;

    // ─── C1: Old commitment is well-formed (unchanged from transfer.circom) ─
    component oldHash = Poseidon(4);
    oldHash.inputs[0] <== 1;
    oldHash.inputs[1] <== cumulativeOld;
    oldHash.inputs[2] <== randomnessOld;
    oldHash.inputs[3] <== userSecret;
    oldCommitment === oldHash.out;

    // ─── C2: New commitment is well-formed ───────────────────────────────────
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
    component nfHash = Poseidon(4);
    nfHash.inputs[0] <== 2;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== epochId;
    nfHash.inputs[3] <== randomnessOld;
    nullifier === nfHash.out;

    // ─── C11: tx amount hash is correctly derived ────────────────────────────
    component txHash = Poseidon(3);
    txHash.inputs[0] <== 3;
    txHash.inputs[1] <== txAmount;
    txHash.inputs[2] <== salt;
    txAmountHash === txHash.out;
}

component main {public [oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot]} = TransferPoseidon2();
