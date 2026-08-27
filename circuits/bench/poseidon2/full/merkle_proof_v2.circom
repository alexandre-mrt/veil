pragma circom 2.2.2;

include "circomlib/circuits/mux1.circom";
include "@taceo/circom-lib/circuits/compression.circom";

// Poseidon2 variant of templates/merkle_proof.circom: identical structure,
// the per-level Poseidon(2) hash replaced with Poseidon2Sponge(2, 3, 0)
// (2-element rate, capacity 0 -- no domain tag, matching the original,
// which never domain-separated tree levels either).
template MerkleProofV2(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    signal nodes[depth + 1];
    nodes[0] <== leaf;

    component mux[depth];

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== nodes[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== nodes[i];
        mux[i].s <== pathIndices[i];

        nodes[i + 1] <== Poseidon2Sponge(2, 3, 0)([mux[i].out[0], mux[i].out[1]]);
    }

    root <== nodes[depth];
}
