pragma circom 2.2.2;

include "@taceo/circom-lib/circuits/precomputations.circom";
include "circomlib/circuits/mux1.circom";

// Same interface and same per-level structure as ../../templates/merkle_proof.circom (mux-selected
// sibling, explicit boolean constraint on each path bit, one hash per level) — the only change is the
// per-level hash: circomlib's `Poseidon(2)` (a t=3 sponge: 2 data elements + 1 capacity element, squeeze 1)
// is replaced with @taceo/circom-lib's raw t=2 permutation used in *compression* mode (both state slots
// are the two children, no capacity element at all) plus a Miyaguchi-Preneel feed-forward
// (`out = permutation(left, right)[0] + left`), exactly the pattern @taceo/circom-lib's own
// `binary_merkle_root.circom` uses for the same job. This is not an arbitrary choice: compression mode is
// only sound for a fixed-arity 2-to-1 node hash (which is exactly what a binary Merkle tree needs) — using
// it here instead of a sponge is the standard, established way to build a Poseidon2 Merkle hasher, not a
// shortcut taken for this benchmark. The feed-forward is required for one-wayness: Poseidon2's permutation
// alone is a public, invertible bijection, so `out := permutation(left, right)[0]` on its own would let
// anyone recover `left, right` from `out` and would make second-preimages trivial (just re-run the
// permutation backwards). `out = permutation(left, right)[0] + left` removes that invertibility (Davies-Meyer
// /Miyaguchi-Preneel over a public permutation is the standard way to build a compression function from
// one), the same reduction circomlib's own sponge-based Poseidon(2) relies on (there, one-wayness comes
// from the discarded capacity element instead).
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
