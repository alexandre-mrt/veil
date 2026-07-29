pragma circom 2.2.2;

include "@taceo/circom-lib/circuits/precomputations.circom";
include "circomlib/circuits/mux1.circom";

// MerkleProof2 — same fixed-depth Merkle-membership template as templates/merkle_proof.circom
// (mux-select left/right per level from pathIndices, chain hashes up to the root), but the
// per-level hash is Poseidon2 in "compression mode" (permutation(left, right)[0] + left) —
// the construction @taceo/circom-lib's own binary_merkle_root.circom uses for tree layers,
// and the cheapest of the two options (T=2, single permutation, no capacity element) since a
// pairwise hash has no domain tag to carry. See
// docs/research/2026-07-29-poseidon2-migration.md.
template MerkleProof2(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    signal nodes[depth + 1];
    nodes[0] <== leaf;

    component mux[depth];
    signal permOut[depth][2];

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== nodes[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== nodes[i];
        mux[i].s <== pathIndices[i];

        permOut[i] <== TACEO_PRECOMPUTATION_Poseidon2(2)([mux[i].out[0], mux[i].out[1]]);
        nodes[i + 1] <== permOut[i][0] + mux[i].out[0];
    }

    root <== nodes[depth];
}
