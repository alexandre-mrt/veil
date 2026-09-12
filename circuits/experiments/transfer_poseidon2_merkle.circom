pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../templates/merkle_proof_poseidon2.circom";

// EXPERIMENTAL — not the production circuit. Byte-for-byte copy of ../transfer.circom
// with the Merkle-path hasher swapped from circomlib's Poseidon(2) (MerkleProof) to
// Poseidon2Hash2 (MerkleProofV2, ../templates/merkle_proof_poseidon2.circom). Exists
// solely to measure the real, whole-circuit constraint/proving-time delta for
// docs/research/2026-09-09-poseidon2-merkle-hasher.md. See that report before reusing
// this file for anything else — in particular, its verifying key is NOT the deployed
// one and this file is not wired into any Move contract or frontend build.
//
// Everything below C0 is unchanged from ../transfer.circom.

template TransferPoseidon2Merkle() {
    signal input oldCommitment;
    signal input newCommitment;
    signal input threshold;
    signal input epochId;
    signal input nullifier;
    signal input txAmountHash;
    signal input merkleRoot;

    signal input cumulativeOld;
    signal input cumulativeNew;
    signal input txAmount;
    signal input randomnessOld;
    signal input randomnessNew;
    signal input userSecret;
    signal input salt;
    signal input pathElements[20];
    signal input pathIndices[20];

    // ─── C0: Old commitment is in the Merkle tree — Poseidon2 hasher ────────
    component membershipProof = MerkleProofV2(20);
    membershipProof.leaf <== oldCommitment;
    for (var i = 0; i < 20; i++) {
        membershipProof.pathElements[i] <== pathElements[i];
        membershipProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === membershipProof.root;

    component oldHash = Poseidon(4);
    oldHash.inputs[0] <== 1;
    oldHash.inputs[1] <== cumulativeOld;
    oldHash.inputs[2] <== randomnessOld;
    oldHash.inputs[3] <== userSecret;
    oldCommitment === oldHash.out;

    component newHash = Poseidon(4);
    newHash.inputs[0] <== 1;
    newHash.inputs[1] <== cumulativeNew;
    newHash.inputs[2] <== randomnessNew;
    newHash.inputs[3] <== userSecret;
    newCommitment === newHash.out;

    cumulativeNew === cumulativeOld + txAmount;

    component gtZero = GreaterThan(64);
    gtZero.in[0] <== txAmount;
    gtZero.in[1] <== 0;
    gtZero.out === 1;

    component oldBits = Num2Bits(64);
    oldBits.in <== cumulativeOld;

    component txBits = Num2Bits(64);
    txBits.in <== txAmount;

    component newBits = Num2Bits(64);
    newBits.in <== cumulativeNew;

    component threshBits = Num2Bits(64);
    threshBits.in <== threshold;

    component ltThreshold = LessEqThan(64);
    ltThreshold.in[0] <== cumulativeNew;
    ltThreshold.in[1] <== threshold;
    ltThreshold.out === 1;

    component nfHash = Poseidon(4);
    nfHash.inputs[0] <== 2;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== epochId;
    nfHash.inputs[3] <== randomnessOld;
    nullifier === nfHash.out;

    component txHash = Poseidon(3);
    txHash.inputs[0] <== 3;
    txHash.inputs[1] <== txAmount;
    txHash.inputs[2] <== salt;
    txAmountHash === txHash.out;
}

component main {public [oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot]} = TransferPoseidon2Merkle();
