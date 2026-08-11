pragma circom 2.1.0;

include "poseidon2_perm.circom";
include "circomlib/circuits/mux1.circom";

// Depth-20 Merkle membership proof, identical control structure to the PRODUCTION
// template (circuits/templates/merkle_proof.circom), with the per-level hash swapped
// from circomlib Poseidon(2) to the Poseidon2 t=3 2-to-1 compression.
//
// NOT production code — exists only so the circomlib-vs-Poseidon2 Merkle path can be
// benchmarked head-to-head (same public interface, same mux/bit-check overhead).
template MerkleProofP2(depth) {
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

        hashers[i] = Compression();
        hashers[i].inp[0] <== mux[i].out[0];
        hashers[i].inp[1] <== mux[i].out[1];
        nodes[i + 1] <== hashers[i].out;
    }

    root <== nodes[depth];
}

component main = MerkleProofP2(20);
