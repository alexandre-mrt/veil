pragma circom 2.1.0;

// Full 20-level Merkle membership proof using circomlib Poseidon(2) per
// level — byte-for-byte the same structure as
// circuits/templates/merkle_proof.circom, copied here so the benchmark
// doesn't depend on a relative include path into circuits/. Used as the
// "before" baseline for the whole-proof (not just single-hash) comparison.

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/mux1.circom";

template P1_Merkle20() {
    signal input leaf;
    signal input pathElements[20];
    signal input pathIndices[20];
    signal output root;

    signal nodes[21];
    nodes[0] <== leaf;

    component mux[20];
    component hashers[20];

    for (var i = 0; i < 20; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== nodes[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== nodes[i];
        mux[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];
        nodes[i + 1] <== hashers[i].out;
    }

    root <== nodes[20];
}

component main = P1_Merkle20();
