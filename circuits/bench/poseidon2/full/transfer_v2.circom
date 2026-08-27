pragma circom 2.2.2;

include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "@taceo/circom-lib/circuits/compression.circom";
include "merkle_proof_v2.circom";

// Poseidon2 variant of transfer.circom, for benchmarking only -- not wired
// into pool.move, not used by the frontend, no new trusted setup performed.
// Identical constraint logic to transfer.circom; every Poseidon(N) call is
// replaced by a Poseidon2Sponge with the domain tag moved from the rate
// into the sponge's dedicated capacity element (see
// docs/research/2026-08-27-poseidon2-hash-swap.md for the soundness
// argument and leakage analysis).
template TransferV2() {
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

    component membershipProof = MerkleProofV2(20);
    membershipProof.leaf <== oldCommitment;
    for (var i = 0; i < 20; i++) {
        membershipProof.pathElements[i] <== pathElements[i];
        membershipProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === membershipProof.root;

    // C1: oldCommitment = H(1, cumulativeOld, randomnessOld, userSecret)
    component oldHash = Poseidon2Sponge(3, 4, 1);
    oldHash.in[0] <== cumulativeOld;
    oldHash.in[1] <== randomnessOld;
    oldHash.in[2] <== userSecret;
    oldCommitment === oldHash.out;

    // C2: newCommitment = H(1, cumulativeNew, randomnessNew, userSecret)
    component newHash = Poseidon2Sponge(3, 4, 1);
    newHash.in[0] <== cumulativeNew;
    newHash.in[1] <== randomnessNew;
    newHash.in[2] <== userSecret;
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

    // C10: nullifier = H(2, userSecret, epochId, randomnessOld)
    component nfHash = Poseidon2Sponge(3, 4, 2);
    nfHash.in[0] <== userSecret;
    nfHash.in[1] <== epochId;
    nfHash.in[2] <== randomnessOld;
    nullifier === nfHash.out;

    // C11: txAmountHash = H(3, txAmount, salt)
    component txHash = Poseidon2Sponge(2, 3, 3);
    txHash.in[0] <== txAmount;
    txHash.in[1] <== salt;
    txAmountHash === txHash.out;
}

component main {public [oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot]} = TransferV2();
