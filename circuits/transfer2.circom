pragma circom 2.2.2;

include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "@taceo/circom-lib/circuits/compression.circom";
include "templates/merkle_proof2.circom";

// Poseidon2 shadow of transfer.circom — same public statement, same 12
// constraints (C0-C11), only the hash primitive changes. Built for the
// 2026-08-21 Poseidon2-vs-Poseidon research experiment: NOT wired into the
// deployed protocol (pool.move, verifier.move, the frontend prover, and the
// existing trusted-setup ceremony all still point at the Poseidon1
// transfer.circom). See docs/research/2026-08-21-poseidon2-hash.md.
//
// Domain separation: the original circuit puts each hash's tag as the
// FIRST Poseidon input (e.g. Poseidon(4) inputs = [tag, ...3 data]). Here
// the tag becomes the sponge's compile-time capacity element (`DS` in
// Poseidon2Sponge) instead of a rate element — same 1:1 mapping from
// domain tag to hash role, just carried in the capacity slot rather than
// as an extra absorbed field element. Tags 1-3 are unchanged from the
// original (see transfer.circom's header comment).
//
// Curve: BN254 (Groth16, Sui curve id 1). Compiled with circom 2.2.x
// (circom2 WASM build), proven with snarkjs 0.7.x.

template Transfer2() {
    // ─── PUBLIC INPUTS (7 total — order matters for Sui on-chain verification) ───
    signal input oldCommitment;
    signal input newCommitment;
    signal input threshold;
    signal input epochId;
    signal input nullifier;
    signal input txAmountHash;
    signal input merkleRoot;

    // ─── PRIVATE INPUTS (7 + Merkle path) ───────────────────────────────────
    signal input cumulativeOld;
    signal input cumulativeNew;
    signal input txAmount;
    signal input randomnessOld;
    signal input randomnessNew;
    signal input userSecret;
    signal input salt;
    signal input pathElements[20];
    signal input pathIndices[20];

    // ─── C0: Old commitment is in the Merkle tree ────────────────────────────
    component membershipProof = MerkleProof2(20);
    membershipProof.leaf <== oldCommitment;
    for (var i = 0; i < 20; i++) {
        membershipProof.pathElements[i] <== pathElements[i];
        membershipProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === membershipProof.root;

    // ─── C1: Old commitment is well-formed ───────────────────────────────────
    // oldCommitment = Poseidon2Sponge(DS=1)(cumulativeOld, randomnessOld, userSecret)
    signal oldHash <== Poseidon2Sponge(3, 4, 1)([cumulativeOld, randomnessOld, userSecret]);
    oldCommitment === oldHash;

    // ─── C2: New commitment is well-formed ───────────────────────────────────
    signal newHash <== Poseidon2Sponge(3, 4, 1)([cumulativeNew, randomnessNew, userSecret]);
    newCommitment === newHash;

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
    // nullifier = Poseidon2Sponge(DS=2)(userSecret, epochId, randomnessOld)
    signal nfHash <== Poseidon2Sponge(3, 4, 2)([userSecret, epochId, randomnessOld]);
    nullifier === nfHash;

    // ─── C11: tx amount hash is correctly derived ────────────────────────────
    // txAmountHash = Poseidon2Sponge(DS=3)(txAmount, salt)
    signal txHash <== Poseidon2Sponge(2, 3, 3)([txAmount, salt]);
    txAmountHash === txHash;
}

component main {public [oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot]} = Transfer2();
