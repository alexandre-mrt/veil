pragma circom 2.2.2;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "templates/merkle_proof_poseidon2.circom";

// Research variant of transfer.circom (2026-09-17 Poseidon2 experiment — see
// docs/research/2026-09-17-poseidon2-merkle-compression.md). Identical to transfer.circom in
// every respect except C0: the Merkle-membership check uses MerkleProof2 (Poseidon2 in 2-to-1
// compression mode, @taceo/circom-lib) instead of MerkleProof (circomlib Poseidon(2) sponge).
// Everything else — commitment/nullifier/txAmountHash derivation (C1-C11), domain tags,
// range checks — is byte-for-byte the same as transfer.circom.
//
// This is a research artifact, not a proposed replacement for transfer.circom. It exists to
// measure the real, whole-circuit constraint-count and proving-time delta of swapping only the
// highest-leverage hash site (the 20-level Merkle path, ~75% of transfer.circom's non-linear
// constraints — see the report's attribution table) to Poseidon2, using the construction mode
// @taceo/circom-lib's own audited Merkle template uses. It is NOT a full-protocol migration: the
// commitment hash (Poseidon(4)) and txAmountHash (Poseidon(3), domain-tag sponge) are unchanged
// because Poseidon2 has no official parameter set for a t=5 state (see the report).
//
// Curve: BN254 (Groth16, Sui curve id 1)
// Compiled with circom 2.2.x, proven with snarkjs 0.7.x

template TransferPoseidon2() {
    // ─── PUBLIC INPUTS (7 total — order matters for Sui on-chain verification) ───
    signal input oldCommitment;    // Poseidon(1, cumulativeOld, randomnessOld, userSecret)
    signal input newCommitment;    // Poseidon(1, cumulativeNew, randomnessNew, userSecret)
    signal input threshold;        // KYC-free epoch limit
    signal input epochId;          // Current epoch identifier (from on-chain Clock)
    signal input nullifier;        // Poseidon(2, userSecret, epochId, randomnessOld)
    signal input txAmountHash;     // Poseidon(3, txAmount, salt) — domain-separated
    signal input merkleRoot;       // Commitment Merkle tree root (anonymity set = all commitments)

    // ─── PRIVATE INPUTS (7 + Merkle path) ───────────────────────────────────
    signal input cumulativeOld;    // Previous cumulative spending this epoch
    signal input cumulativeNew;    // cumulativeOld + txAmount
    signal input txAmount;         // This transaction's amount
    signal input randomnessOld;    // Blinding factor for oldCommitment
    signal input randomnessNew;    // Blinding factor for newCommitment
    signal input userSecret;       // User's master secret (never revealed)
    signal input salt;             // Salt for txAmountHash
    signal input pathElements[20]; // Merkle sibling hashes (depth 20)
    signal input pathIndices[20];  // Left/right flags (0 or 1)

    // ─── C0: Old commitment is in the Merkle tree (anonymity set proof) ─────
    // Poseidon2 compression-mode variant of the membership check — see file docstring.
    component membershipProof = MerkleProof2(20);
    membershipProof.leaf <== oldCommitment;
    for (var i = 0; i < 20; i++) {
        membershipProof.pathElements[i] <== pathElements[i];
        membershipProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === membershipProof.root;

    // ─── C1: Old commitment is well-formed ───────────────────────────────────
    component oldHash = Poseidon(4);
    oldHash.inputs[0] <== 1;
    oldHash.inputs[1] <== cumulativeOld;
    oldHash.inputs[2] <== randomnessOld;
    oldHash.inputs[3] <== userSecret;
    oldCommitment === oldHash.out;

    // ─── C2: New commitment is well-formed ───────────────────────────────────
    component newHash = Poseidon(4);
    newHash.inputs[0] <== 1;
    newHash.inputs[1] <== cumulativeNew;
    newHash.inputs[2] <== randomnessNew;
    newHash.inputs[3] <== userSecret;
    newCommitment === newHash.out;

    // ─── C3: Cumulative update is correct ────────────────────────────────────
    cumulativeNew === cumulativeOld + txAmount;

    // ─── C4: txAmount > 0 ────────────────────────────────────────────────────
    component gtZero = GreaterThan(64);
    gtZero.in[0] <== txAmount;
    gtZero.in[1] <== 0;
    gtZero.out === 1;

    // ─── C5-C7: Range proofs [0, 2^64) ──────────────────────────────────────
    component oldBits = Num2Bits(64);
    oldBits.in <== cumulativeOld;

    component txBits = Num2Bits(64);
    txBits.in <== txAmount;

    component newBits = Num2Bits(64);
    newBits.in <== cumulativeNew;

    // ─── C8: Threshold range proof ───────────────────────────────────────────
    component threshBits = Num2Bits(64);
    threshBits.in <== threshold;

    // ─── C9: Cumulative spending under threshold ─────────────────────────────
    component ltThreshold = LessEqThan(64);
    ltThreshold.in[0] <== cumulativeNew;
    ltThreshold.in[1] <== threshold;
    ltThreshold.out === 1;

    // ─── C10: Nullifier is correctly derived ─────────────────────────────────
    component nfHash = Poseidon(4);
    nfHash.inputs[0] <== 2;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== epochId;
    nfHash.inputs[3] <== randomnessOld;
    nullifier === nfHash.out;

    // ─── C11: tx amount hash is correctly derived ────────────────────────────
    component txHash = Poseidon(3);
    txHash.inputs[0] <== 3;
    txHash.inputs[1] <== txAmount;
    txHash.inputs[2] <== salt;
    txAmountHash === txHash.out;
}

component main {public [oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot]} = TransferPoseidon2();
