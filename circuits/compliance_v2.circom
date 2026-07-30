pragma circom 2.1.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "templates/merkle_proof_v2.circom";

// EXPERIMENTAL (docs/research/2026-07-30-poseidon2-merkle-hash.md): identical to
// compliance.circom except the depth-20 credential Merkle-path hasher is MerkleProofV2
// (Poseidon2 permutation) instead of MerkleProof (circomlib Poseidon). Every other
// constraint, domain tag, and public/private input is unchanged.
//
// Compliance circuit for Veil Tier 3 KYC credential proof.
//
// When cumulative spending exceeds the Tier 2 threshold, users must
// provide a SEPARATE Groth16 proof that they hold a valid KYC credential
// in the issuer Merkle tree — without revealing their identity.
//
// Domain separation tags (first Poseidon input):
//   4 -> credential leaf hash  H(4, userSecret, kycLevel, expiryEpoch, issuerId)
//   5 -> compliance nullifier  H(5, userSecret, contextId)
//   6 -> context binding hash  H(6, transferNullifier, userSecret)
//
// Tags 1-3 are reserved by the transfer circuit (transfer.circom).
//
// Constraints (11):
//   C1  credential leaf hash       C2  Merkle membership
//   C3  nullifier derivation       C_BIND context binding
//   C4  expiry check               C5  KYC level check
//   C6  validCredential output     C7-C8 epoch range proofs
//   C9  kycLevel range proof       C10 requiredKycLevel range proof (M-01 fix)
//   C11 issuerId range proof
//
// Public inputs (6):
//   merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential
//
// Curve: BN254 (Groth16, Sui curve id 1)
// Compiled with circom 2.1.x, proven with snarkjs 0.7.x

template Compliance(merkleDepth) {
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

    // --- C1: Credential leaf is well-formed ---
    // leaf = Poseidon(4, userSecret, kycLevel, expiryEpoch, issuerId)
    component leafHash = Poseidon(5);
    leafHash.inputs[0] <== 4;
    leafHash.inputs[1] <== userSecret;
    leafHash.inputs[2] <== kycLevel;
    leafHash.inputs[3] <== expiryEpoch;
    leafHash.inputs[4] <== issuerId;

    // --- C2: Credential is in the Merkle tree ---
    component merkleProof = MerkleProofV2(merkleDepth);
    merkleProof.leaf <== leafHash.out;
    for (var i = 0; i < merkleDepth; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === merkleProof.root;

    // --- C3: Nullifier is correctly derived ---
    // nullifier = Poseidon(5, userSecret, contextId)
    component nfHash = Poseidon(3);
    nfHash.inputs[0] <== 5;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== contextId;
    nullifier === nfHash.out;

    // --- C_BIND: Context binding (transfer nullifier hidden) ---
    // contextId = Poseidon(6, transferNullifier, userSecret)
    // Proves compliance proof is bound to a specific transfer without
    // revealing transferNullifier as a public input (fixes C4 linkability).
    component ctxHash = Poseidon(3);
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

    // --- C9: Range proof for kycLevel (SKILL-002 fix) ---
    // Prevents large field elements from wrapping in GreaterEqThan(8) comparator
    component kycBits = Num2Bits(8);
    kycBits.in <== kycLevel;

    // --- C10: Range proof for requiredKycLevel (prevents 8-bit wraparound in GreaterEqThan) ---
    component reqKycBits = Num2Bits(8);
    reqKycBits.in <== requiredKycLevel;

    // --- C11: Range proof for issuerId ---
    component issuerBits = Num2Bits(64);
    issuerBits.in <== issuerId;
}

component main {public [merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential]} = Compliance(20);
