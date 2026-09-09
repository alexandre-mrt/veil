pragma circom 2.2.2;

include "../../node_modules/circomlib/circuits/comparators.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";
include "templates/poseidon2_hash.circom";
include "templates/merkle_proof2.circom";

// Experiment mirror of ../../transfer.circom: every `Poseidon(n)` component is replaced with
// `Poseidon2Hash(n)` and the depth-20 `MerkleProof` with `MerkleProof2` (see templates/ in this
// directory for what each wraps). Every other line — the constraint graph itself, public/private input
// layout, domain tags — is unchanged from the original, so `snarkjs r1cs info` on the two compiled
// circuits is a same-shape comparison, not an artifact of some other change riding along. Not wired
// into scripts/, contracts/, or frontend/ — this is a measurement fixture, not a protocol change.
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

    component membershipProof = MerkleProof2(20);
    membershipProof.leaf <== oldCommitment;
    for (var i = 0; i < 20; i++) {
        membershipProof.pathElements[i] <== pathElements[i];
        membershipProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === membershipProof.root;

    component oldHash = Poseidon2Hash(4);
    oldHash.inputs[0] <== 1;
    oldHash.inputs[1] <== cumulativeOld;
    oldHash.inputs[2] <== randomnessOld;
    oldHash.inputs[3] <== userSecret;
    oldCommitment === oldHash.out;

    component newHash = Poseidon2Hash(4);
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

    component nfHash = Poseidon2Hash(4);
    nfHash.inputs[0] <== 2;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== epochId;
    nfHash.inputs[3] <== randomnessOld;
    nullifier === nfHash.out;

    component txHash = Poseidon2Hash(3);
    txHash.inputs[0] <== 3;
    txHash.inputs[1] <== txAmount;
    txHash.inputs[2] <== salt;
    txAmountHash === txHash.out;
}

component main {public [oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot]} = Transfer2();
