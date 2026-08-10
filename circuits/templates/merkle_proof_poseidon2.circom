pragma circom 2.2.2;

include "../node_modules/circomlib/circuits/mux1.circom";
include "poseidon2_hash.circom";

// Same shape and semantics as templates/merkle_proof.circom (production), with
// the per-level Poseidon(2) sponge call (t=3, circomlib) replaced by a
// Poseidon2(3) sponge call (t=3, @taceo/circom-lib) — same construction
// (capacity-0 sponge, rate 2), only the permutation differs. See
// docs/research/2026-08-10-poseidon2-merkle.md for the soundness argument.
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

        hashers[i] = Poseidon2Hash(3);
        hashers[i].state[0] <== 0;
        hashers[i].state[1] <== mux[i].out[0];
        hashers[i].state[2] <== mux[i].out[1];
        nodes[i + 1] <== hashers[i].out;
    }

    root <== nodes[depth];
}
