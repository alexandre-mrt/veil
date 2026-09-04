pragma circom 2.1.0;

include "lib/poseidon2_compress.circom";
include "lib/merkle_proof_poseidon2.circom";

// Poseidon2 counterpart of compliance_hash_current.circom. The leaf hash is the
// interesting case: 4 non-tag values need Poseidon2 width T=8 (rate 7) because
// Poseidon2's published parameter set has no T=5/6 — wider, and therefore more
// expensive per-permutation, than circomlib's native Poseidon(5) (t=6). See the
// width table in docs/research/2026-09-04-poseidon2-constraints.md.
template ComplianceHashPoseidon2() {
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

    signal leafVals[4];
    leafVals[0] <== userSecret;
    leafVals[1] <== kycLevel;
    leafVals[2] <== expiryEpoch;
    leafVals[3] <== issuerId;
    signal leafHashOut <== Poseidon2CompressTagged(4, 8, 4)(leafVals);

    component merkleProof = MerkleProofPoseidon2(20, 9);
    merkleProof.leaf <== leafHashOut;
    for (var i = 0; i < 20; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === merkleProof.root;

    signal nfVals[2];
    nfVals[0] <== userSecret;
    nfVals[1] <== contextId;
    signal nfHashOut <== Poseidon2CompressTagged(2, 3, 5)(nfVals);
    nullifier === nfHashOut;

    signal ctxVals[2];
    ctxVals[0] <== transferNullifier;
    ctxVals[1] <== userSecret;
    signal ctxHashOut <== Poseidon2CompressTagged(2, 3, 6)(ctxVals);
    contextId === ctxHashOut;
}

component main {public [merkleRoot, contextId, nullifier]} = ComplianceHashPoseidon2();
