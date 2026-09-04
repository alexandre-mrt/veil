pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../templates/merkle_proof.circom";

// Hash-only skeleton of transfer.circom (production circuit, see ../transfer.circom):
// isolates exactly the Poseidon-related constraints (3x Poseidon(4) compression,
// 1x Poseidon(3), one 20-deep Poseidon(2) Merkle proof), dropping the arithmetic
// constraints (Num2Bits range checks, GreaterThan, LessEqThan, the cumulative-sum
// equality) that are identical regardless of which hash function is used. That
// isolation is the point: it lets constraint-count and proving-time comparisons
// against transfer_hash_poseidon2.circom measure only the hash-function delta.
// See docs/research/2026-09-04-poseidon2-constraints.md.
template TransferHashCurrent() {
    signal input oldCommitment;
    signal input newCommitment;
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
    signal input epochId;
    signal input pathElements[20];
    signal input pathIndices[20];

    component membershipProof = MerkleProof(20);
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

component main {public [oldCommitment, newCommitment, nullifier, txAmountHash, merkleRoot]} = TransferHashCurrent();
