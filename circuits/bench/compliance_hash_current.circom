pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../templates/merkle_proof.circom";

// Hash-only skeleton of compliance.circom: 1x Poseidon(5) leaf hash, 2x
// Poseidon(3) (nullifier + context binding), one 20-deep Poseidon(2) Merkle
// proof. Drops the expiry/kycLevel comparator and range-check constraints —
// see transfer_hash_current.circom for why.
template ComplianceHashCurrent() {
    signal input merkleRoot;
    signal input contextId;
    signal input nullifier;

    signal input userSecret;
    signal input kycLevel;
    signal input expiryEpoch;
    signal input issuerId;
    signal input pathElements[20];
    signal input pathIndices[20];
    signal input transferNullifier;

    component leafHash = Poseidon(5);
    leafHash.inputs[0] <== 4;
    leafHash.inputs[1] <== userSecret;
    leafHash.inputs[2] <== kycLevel;
    leafHash.inputs[3] <== expiryEpoch;
    leafHash.inputs[4] <== issuerId;

    component merkleProof = MerkleProof(20);
    merkleProof.leaf <== leafHash.out;
    for (var i = 0; i < 20; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === merkleProof.root;

    component nfHash = Poseidon(3);
    nfHash.inputs[0] <== 5;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== contextId;
    nullifier === nfHash.out;

    component ctxHash = Poseidon(3);
    ctxHash.inputs[0] <== 6;
    ctxHash.inputs[1] <== transferNullifier;
    ctxHash.inputs[2] <== userSecret;
    contextId === ctxHash.out;
}

component main {public [merkleRoot, contextId, nullifier]} = ComplianceHashCurrent();
