pragma circom 2.2.2;

include "@taceo/circom-lib/circuits/precomputations.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

// Poseidon2 counterpart of merkle_proof.circom's MerkleProof(depth). Same
// mux-based left/right selection, same explicit pathIndices booleanity check
// — only the hash primitive changes, so this is an apples-to-apples swap,
// not a redesign.
template MerkleProof2(depth) {
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

        // Compression mode (Miyaguchi-Preneel over the Poseidon2 permutation),
        // same construction as @taceo/circom-lib's binary_merkle_root.circom.
        var perm[2] = TACEO_PRECOMPUTATION_Poseidon2(2)([mux[i].out[0], mux[i].out[1]]);
        nodes[i + 1] <== perm[0] + mux[i].out[0];
    }

    root <== nodes[depth];
}
