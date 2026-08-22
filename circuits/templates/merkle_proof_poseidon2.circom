pragma circom 2.1.0;

include "poseidon2_hash.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

// Poseidon2MerkleProof(depth) — identical to templates/merkle_proof.circom
// (same MultiMux1 sibling-ordering logic, same public interface: leaf,
// pathElements[depth], pathIndices[depth] -> root), except each node hash is
// Poseidon2Hash(2) (t=3) instead of circomlib's Poseidon(2). See
// docs/research/2026-08-22-poseidon2-hash-swap.md.
template Poseidon2MerkleProof(depth) {
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

        hashers[i] = Poseidon2Hash(2);
        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];
        nodes[i + 1] <== hashers[i].out;
    }

    root <== nodes[depth];
}
