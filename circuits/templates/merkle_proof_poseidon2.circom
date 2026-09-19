pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/mux1.circom";
include "./poseidon2_bn254_t3.circom";

// Identical to MerkleProof(depth) in merkle_proof.circom, except each sibling
// hash uses Poseidon2Hash2to1 (poseidon2_bn254_t3.circom) instead of
// circomlib's Poseidon(2). See docs/research/2026-09-19-poseidon2-merkle-swap.md
// for why this swap and the real constraint/proving-time delta it measures.
template MerkleProofPoseidon2(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    signal nodes[depth + 1];
    nodes[0] <== leaf;

    component mux[depth];
    component hashers[depth];

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== nodes[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== nodes[i];
        mux[i].s <== pathIndices[i];

        hashers[i] = Poseidon2Hash2to1();
        hashers[i].in[0] <== mux[i].out[0];
        hashers[i].in[1] <== mux[i].out[1];
        nodes[i + 1] <== hashers[i].out;
    }

    root <== nodes[depth];
}
