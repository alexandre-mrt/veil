pragma circom 2.2.2;

include "../../node_modules/circomlib/circuits/comparators.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";
include "templates/poseidon2_hash.circom";
include "templates/merkle_proof2.circom";

// Experiment mirror of ../../compliance.circom — see transfer2.circom's header comment for the swap
// rule. `leafHash` (Poseidon(5) in the original) is the other arity that has no supported Poseidon2
// width of its own (t=6); like the transfer circuit's Poseidon(4) calls, it pays for a padded t=8
// permutation instead of a tight one.
template Compliance2(merkleDepth) {
    signal input merkleRoot;
    signal input currentEpoch;
    signal input contextId;
    signal input requiredKycLevel;
    signal input nullifier;
    signal input validCredential;

    signal input userSecret;
    signal input kycLevel;
    signal input expiryEpoch;
    signal input issuerId;
    signal input pathElements[merkleDepth];
    signal input pathIndices[merkleDepth];
    signal input transferNullifier;

    component leafHash = Poseidon2Hash(5);
    leafHash.inputs[0] <== 4;
    leafHash.inputs[1] <== userSecret;
    leafHash.inputs[2] <== kycLevel;
    leafHash.inputs[3] <== expiryEpoch;
    leafHash.inputs[4] <== issuerId;

    component merkleProof = MerkleProof2(merkleDepth);
    merkleProof.leaf <== leafHash.out;
    for (var i = 0; i < merkleDepth; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === merkleProof.root;

    component nfHash = Poseidon2Hash(3);
    nfHash.inputs[0] <== 5;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== contextId;
    nullifier === nfHash.out;

    component ctxHash = Poseidon2Hash(3);
    ctxHash.inputs[0] <== 6;
    ctxHash.inputs[1] <== transferNullifier;
    ctxHash.inputs[2] <== userSecret;
    contextId === ctxHash.out;

    component expiryCheck = GreaterEqThan(64);
    expiryCheck.in[0] <== expiryEpoch;
    expiryCheck.in[1] <== currentEpoch;

    component kycCheck = GreaterEqThan(8);
    kycCheck.in[0] <== kycLevel;
    kycCheck.in[1] <== requiredKycLevel;

    expiryCheck.out * (1 - expiryCheck.out) === 0;
    kycCheck.out * (1 - kycCheck.out) === 0;

    signal computedValid;
    computedValid <== expiryCheck.out * kycCheck.out;
    validCredential === computedValid;

    component epochBits = Num2Bits(64);
    epochBits.in <== currentEpoch;

    component expiryBits = Num2Bits(64);
    expiryBits.in <== expiryEpoch;

    component kycBits = Num2Bits(8);
    kycBits.in <== kycLevel;

    component reqKycBits = Num2Bits(8);
    reqKycBits.in <== requiredKycLevel;

    component issuerBits = Num2Bits(64);
    issuerBits.in <== issuerId;
}

component main {public [merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential]} = Compliance2(20);
