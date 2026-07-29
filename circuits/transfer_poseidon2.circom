pragma circom 2.2.2;

include "templates/poseidon2_compat.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "templates/merkle_proof_poseidon2.circom";

// Poseidon2 variant of transfer.circom — identical constraints, semantics, domain-tag
// scheme, and public/private input layout, with every Poseidon(N) call and the Merkle
// tree's pairwise hash swapped for Poseidon2 (@taceo/circom-lib). Built to measure the
// constraint-count / proving-time delta from the hash-primitive swap alone. See
// docs/research/2026-07-29-poseidon2-migration.md.
//
// Domain separation tags (first Poseidon2 input) — unchanged from transfer.circom:
//   1 -> commitment hash   H(1, cumulative, randomness, userSecret)
//   2 -> nullifier hash    H(2, userSecret, epochId, randomnessOld)
//   3 -> txAmountHash      H(3, txAmount, salt)

template Transfer2() {
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

    // C0: Old commitment is in the Merkle tree
    component membershipProof = MerkleProof2(20);
    membershipProof.leaf <== oldCommitment;
    for (var i = 0; i < 20; i++) {
        membershipProof.pathElements[i] <== pathElements[i];
        membershipProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === membershipProof.root;

    // C1: Old commitment is well-formed
    component oldHash = Poseidon2Hash(4);
    oldHash.inputs[0] <== 1;
    oldHash.inputs[1] <== cumulativeOld;
    oldHash.inputs[2] <== randomnessOld;
    oldHash.inputs[3] <== userSecret;
    oldCommitment === oldHash.out;

    // C2: New commitment is well-formed
    component newHash = Poseidon2Hash(4);
    newHash.inputs[0] <== 1;
    newHash.inputs[1] <== cumulativeNew;
    newHash.inputs[2] <== randomnessNew;
    newHash.inputs[3] <== userSecret;
    newCommitment === newHash.out;

    // C3: Cumulative update is correct
    cumulativeNew === cumulativeOld + txAmount;

    // C4: txAmount > 0
    component gtZero = GreaterThan(64);
    gtZero.in[0] <== txAmount;
    gtZero.in[1] <== 0;
    gtZero.out === 1;

    // C5-C7: Range proofs [0, 2^64)
    component oldBits = Num2Bits(64);
    oldBits.in <== cumulativeOld;

    component txBits = Num2Bits(64);
    txBits.in <== txAmount;

    component newBits = Num2Bits(64);
    newBits.in <== cumulativeNew;

    // C8: Threshold range proof
    component threshBits = Num2Bits(64);
    threshBits.in <== threshold;

    // C9: Cumulative spending under threshold
    component ltThreshold = LessEqThan(64);
    ltThreshold.in[0] <== cumulativeNew;
    ltThreshold.in[1] <== threshold;
    ltThreshold.out === 1;

    // C10: Nullifier is correctly derived
    component nfHash = Poseidon2Hash(4);
    nfHash.inputs[0] <== 2;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== epochId;
    nfHash.inputs[3] <== randomnessOld;
    nullifier === nfHash.out;

    // C11: tx amount hash is correctly derived
    component txHash = Poseidon2Hash(3);
    txHash.inputs[0] <== 3;
    txHash.inputs[1] <== txAmount;
    txHash.inputs[2] <== salt;
    txAmountHash === txHash.out;
}

component main {public [oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot]} = Transfer2();
