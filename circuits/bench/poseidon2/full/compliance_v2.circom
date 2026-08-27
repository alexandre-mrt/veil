pragma circom 2.2.2;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "@taceo/circom-lib/circuits/compression.circom";
include "merkle_proof_v2.circom";

// Poseidon2 variant of compliance.circom, for benchmarking only -- see
// transfer_v2.circom's header for scope notes.
//
// PARTIAL SWAP: the credential leaf hash (C1) needs a 4-data-input sponge,
// i.e. Poseidon2 state size t=5. @taceo/circom-lib's Poseidon2 only ships
// t in {2,3,4,8,12,16} (see poseidon2_constants.circom) -- t=5 round
// constants are not published there, and this experiment does not derive
// its own (see the report's soundness note on why that's out of scope for
// one night). C1 therefore stays the original circomlib Poseidon(5); every
// other hash (Merkle levels, nullifier, context binding) is swapped.
template ComplianceV2(merkleDepth) {
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

    // C1: leaf = H(4, userSecret, kycLevel, expiryEpoch, issuerId) -- UNCHANGED (t=5 gap)
    component leafHash = Poseidon(5);
    leafHash.inputs[0] <== 4;
    leafHash.inputs[1] <== userSecret;
    leafHash.inputs[2] <== kycLevel;
    leafHash.inputs[3] <== expiryEpoch;
    leafHash.inputs[4] <== issuerId;

    component merkleProof = MerkleProofV2(merkleDepth);
    merkleProof.leaf <== leafHash.out;
    for (var i = 0; i < merkleDepth; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === merkleProof.root;

    // C3: nullifier = H(5, userSecret, contextId)
    component nfHash = Poseidon2Sponge(2, 3, 5);
    nfHash.in[0] <== userSecret;
    nfHash.in[1] <== contextId;
    nullifier === nfHash.out;

    // C_BIND: contextId = H(6, transferNullifier, userSecret)
    component ctxHash = Poseidon2Sponge(2, 3, 6);
    ctxHash.in[0] <== transferNullifier;
    ctxHash.in[1] <== userSecret;
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

component main {public [merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential]} = ComplianceV2(20);
