pragma circom 2.2.2;

include "../../../circuits/node_modules/circomlib/circuits/poseidon.circom";
include "../../../circuits/node_modules/circomlib/circuits/comparators.circom";
include "../../../circuits/node_modules/circomlib/circuits/bitify.circom";
include "../../../circuits/templates/merkle_proof_poseidon2.circom";
include "../../../circuits/templates/poseidon2_hash.circom";

// Research prototype — NOT wired into production. Identical logic to
// circuits/transfer.circom (v2, audit fixes), with the two hash calls that
// have a native Poseidon2 width available swapped to Poseidon2:
//   - the depth-20 Merkle-membership sponge (t=3)      -> Poseidon2(3)
//   - txAmountHash, Poseidon(3, tag, txAmount, salt), t=4 -> Poseidon2(4)
// oldHash/newHash/nfHash stay on production Poseidon(4) (t=5): Poseidon2 has
// no native t=5 width (see hash_arity4_poseidon2_padded.circom — padding to
// t=8 measured strictly worse in isolation, so it is not repeated here).
// See docs/research/2026-08-10-poseidon2-merkle.md for the full comparison,
// soundness argument, and leakage analysis.

template TransferPoseidon2() {
    signal input oldCommitment;
    signal input newCommitment;
    signal input threshold;
    signal input epochId;
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
    signal input pathElements[20];
    signal input pathIndices[20];

    // ─── C0: Old commitment is in the Merkle tree — Poseidon2(3) sponge ─────
    component membershipProof = MerkleProofPoseidon2(20);
    membershipProof.leaf <== oldCommitment;
    for (var i = 0; i < 20; i++) {
        membershipProof.pathElements[i] <== pathElements[i];
        membershipProof.pathIndices[i] <== pathIndices[i];
    }
    merkleRoot === membershipProof.root;

    // ─── C1/C2: commitments — unchanged, production Poseidon(4) (t=5) ───────
    component oldHash = Poseidon(4);
    oldHash.inputs[0] <== 1;
    oldHash.inputs[1] <== cumulativeOld;
    oldHash.inputs[2] <== randomnessOld;
    oldHash.inputs[3] <== userSecret;
    oldCommitment === oldHash.out;

    component newHash = Poseidon(4);
    newHash.inputs[0] <== 1;
    newHash.inputs[1] <== cumulativeNew;
    newHash.inputs[2] <== randomnessNew;
    newHash.inputs[3] <== userSecret;
    newCommitment === newHash.out;

    // ─── C3-C9: arithmetic, unchanged ────────────────────────────────────────
    cumulativeNew === cumulativeOld + txAmount;

    component gtZero = GreaterThan(64);
    gtZero.in[0] <== txAmount;
    gtZero.in[1] <== 0;
    gtZero.out === 1;

    component oldBits = Num2Bits(64);
    oldBits.in <== cumulativeOld;
    component txBits = Num2Bits(64);
    txBits.in <== txAmount;
    component newBits = Num2Bits(64);
    newBits.in <== cumulativeNew;
    component threshBits = Num2Bits(64);
    threshBits.in <== threshold;

    component ltThreshold = LessEqThan(64);
    ltThreshold.in[0] <== cumulativeNew;
    ltThreshold.in[1] <== threshold;
    ltThreshold.out === 1;

    // ─── C10: nullifier — unchanged, production Poseidon(4) (t=5) ───────────
    component nfHash = Poseidon(4);
    nfHash.inputs[0] <== 2;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== epochId;
    nfHash.inputs[3] <== randomnessOld;
    nullifier === nfHash.out;

    // ─── C11: tx amount hash — Poseidon2(4) sponge (t=4, native width) ──────
    signal txHash <== Poseidon2Hash(4)([0, 3, txAmount, salt]);
    txAmountHash === txHash;
}

component main {public [oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot]} = TransferPoseidon2();
