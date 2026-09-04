pragma circom 2.1.0;

include "lib/poseidon2_compress.circom";
include "lib/merkle_proof_poseidon2.circom";

// Poseidon2 counterpart of transfer_hash_current.circom — same signal interface,
// same four hash call sites and one 20-deep Merkle proof, but every hash goes
// through Poseidon2CompressTagged (SAFE-style: domain tag in the capacity element,
// not a rate slot — see lib/poseidon2_compress.circom) instead of circomlib's
// Poseidon(N). Domain tags 1/2/3 match transfer.circom's; MERKLE_TAG=9 is new
// (tags 1-8 are reserved by the production circuits — see the domain-tag table in
// docs/research/2026-09-04-poseidon2-constraints.md).
template TransferHashPoseidon2() {
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

    component membershipProof = MerkleProofPoseidon2(20, 9);
    membershipProof.leaf <== oldCommitment;
    for (var i = 0; i < 20; i++) {
        membershipProof.pathElements[i] <== pathElements[i];
        membershipProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === membershipProof.root;

    signal oldVals[3];
    oldVals[0] <== cumulativeOld;
    oldVals[1] <== randomnessOld;
    oldVals[2] <== userSecret;
    signal oldHashOut <== Poseidon2CompressTagged(3, 4, 1)(oldVals);
    oldCommitment === oldHashOut;

    signal newVals[3];
    newVals[0] <== cumulativeNew;
    newVals[1] <== randomnessNew;
    newVals[2] <== userSecret;
    signal newHashOut <== Poseidon2CompressTagged(3, 4, 1)(newVals);
    newCommitment === newHashOut;

    signal nfVals[3];
    nfVals[0] <== userSecret;
    nfVals[1] <== epochId;
    nfVals[2] <== randomnessOld;
    signal nfHashOut <== Poseidon2CompressTagged(3, 4, 2)(nfVals);
    nullifier === nfHashOut;

    signal txVals[2];
    txVals[0] <== txAmount;
    txVals[1] <== salt;
    signal txHashOut <== Poseidon2CompressTagged(2, 3, 3)(txVals);
    txAmountHash === txHashOut;
}

component main {public [oldCommitment, newCommitment, nullifier, txAmountHash, merkleRoot]} = TransferHashPoseidon2();
