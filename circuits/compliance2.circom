pragma circom 2.2.2;

include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "@taceo/circom-lib/circuits/compression.circom";
include "templates/merkle_proof2.circom";

// Poseidon2 shadow of compliance.circom. See transfer2.circom's header for
// the shared design notes (not wired into the deployed protocol; tag now
// lives in the sponge's capacity element instead of the rate).
//
// Domain tags (unchanged from compliance.circom):
//   4 -> credential leaf hash    5 -> compliance nullifier    6 -> context binding

template Compliance2(merkleDepth) {
    // --- PUBLIC INPUTS (6 total) ---
    signal input merkleRoot;
    signal input currentEpoch;
    signal input contextId;
    signal input requiredKycLevel;
    signal input nullifier;
    signal input validCredential;

    // --- PRIVATE INPUTS ---
    signal input userSecret;
    signal input kycLevel;
    signal input expiryEpoch;
    signal input issuerId;
    signal input pathElements[merkleDepth];
    signal input pathIndices[merkleDepth];
    signal input transferNullifier;

    // --- C1: Credential leaf is well-formed ---
    // leaf = Poseidon2Sponge(DS=4)(userSecret, kycLevel, expiryEpoch, issuerId)
    // 4 data elements need rate >= 4, so T=8 (next size up in {2,3,4,8,12,16}).
    signal leafHash <== Poseidon2Sponge(4, 8, 4)([userSecret, kycLevel, expiryEpoch, issuerId]);

    // --- C2: Credential is in the Merkle tree ---
    component merkleProof = MerkleProof2(merkleDepth);
    merkleProof.leaf <== leafHash;
    for (var i = 0; i < merkleDepth; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === merkleProof.root;

    // --- C3: Nullifier is correctly derived ---
    // nullifier = Poseidon2Sponge(DS=5)(userSecret, contextId)
    signal nfHash <== Poseidon2Sponge(2, 3, 5)([userSecret, contextId]);
    nullifier === nfHash;

    // --- C_BIND: Context binding (transfer nullifier hidden) ---
    // contextId = Poseidon2Sponge(DS=6)(transferNullifier, userSecret)
    signal ctxHash <== Poseidon2Sponge(2, 3, 6)([transferNullifier, userSecret]);
    contextId === ctxHash;

    // --- C4: Credential has not expired ---
    component expiryCheck = GreaterEqThan(64);
    expiryCheck.in[0] <== expiryEpoch;
    expiryCheck.in[1] <== currentEpoch;

    // --- C5: KYC level meets requirement ---
    component kycCheck = GreaterEqThan(8);
    kycCheck.in[0] <== kycLevel;
    kycCheck.in[1] <== requiredKycLevel;

    // Defense-in-depth: enforce comparator outputs are binary (L7 audit fix)
    expiryCheck.out * (1 - expiryCheck.out) === 0;
    kycCheck.out * (1 - kycCheck.out) === 0;

    // --- C6: validCredential = expiryValid AND kycValid ---
    signal computedValid;
    computedValid <== expiryCheck.out * kycCheck.out;
    validCredential === computedValid;

    // --- C7-C8: Range proofs for epoch values ---
    component epochBits = Num2Bits(64);
    epochBits.in <== currentEpoch;

    component expiryBits = Num2Bits(64);
    expiryBits.in <== expiryEpoch;

    // --- C9: Range proof for kycLevel ---
    component kycBits = Num2Bits(8);
    kycBits.in <== kycLevel;

    // --- C10: Range proof for requiredKycLevel ---
    component reqKycBits = Num2Bits(8);
    reqKycBits.in <== requiredKycLevel;

    // --- C11: Range proof for issuerId ---
    component issuerBits = Num2Bits(64);
    issuerBits.in <== issuerId;
}

component main {public [merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential]} = Compliance2(20);
