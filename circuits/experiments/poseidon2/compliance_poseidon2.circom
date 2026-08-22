pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";
include "../../templates/merkle_proof_poseidon2.circom";
include "../../templates/poseidon2_hash.circom";

// EXPERIMENTAL variant of ../../compliance.circom — see
// docs/research/2026-08-22-poseidon2-hash-swap.md. NOT wired into the pool
// (contracts/), NOT a drop-in replacement for compliance.circom.
//
// Swapped to Poseidon2 (verified round constants exist at these widths):
//   - C2: credential Merkle membership node hash, Poseidon(2)/t=3 -> Poseidon2Hash(2), x20
//   - C3: compliance nullifier, Poseidon(3)/t=4 -> Poseidon2Hash(3)
//   - C_BIND: context binding hash, Poseidon(3)/t=4 -> Poseidon2Hash(3)
//
// Left UNCHANGED on the original Poseidon (no audited t=6 Poseidon2 BN254
// round constants were found in any reachable package this session):
//   - C1: credential leaf hash, Poseidon(5)/t=6
template CompliancePoseidon2(merkleDepth) {
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
    signal input transferNullifier;  // Transfer nullifier (private — not revealed)

    // --- C1: Credential leaf is well-formed (unchanged: Poseidon(5), t=6) ---
    component leafHash = Poseidon(5);
    leafHash.inputs[0] <== 4;
    leafHash.inputs[1] <== userSecret;
    leafHash.inputs[2] <== kycLevel;
    leafHash.inputs[3] <== expiryEpoch;
    leafHash.inputs[4] <== issuerId;

    // --- C2: Credential is in the Merkle tree (Poseidon2 node hash) ---
    component merkleProof = Poseidon2MerkleProof(merkleDepth);
    merkleProof.leaf <== leafHash.out;
    for (var i = 0; i < merkleDepth; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === merkleProof.root;

    // --- C3: Nullifier is correctly derived (Poseidon2Hash(3), t=4) ---
    component nfHash = Poseidon2Hash(3);
    nfHash.inputs[0] <== 5;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== contextId;
    nullifier === nfHash.out;

    // --- C_BIND: Context binding (Poseidon2Hash(3), t=4) ---
    component ctxHash = Poseidon2Hash(3);
    ctxHash.inputs[0] <== 6;
    ctxHash.inputs[1] <== transferNullifier;
    ctxHash.inputs[2] <== userSecret;
    contextId === ctxHash.out;

    // --- C4: Credential has not expired ---
    component expiryCheck = GreaterEqThan(64);
    expiryCheck.in[0] <== expiryEpoch;
    expiryCheck.in[1] <== currentEpoch;

    // --- C5: KYC level meets requirement ---
    component kycCheck = GreaterEqThan(8);
    kycCheck.in[0] <== kycLevel;
    kycCheck.in[1] <== requiredKycLevel;

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

component main {public [merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential]} = CompliancePoseidon2(20);
