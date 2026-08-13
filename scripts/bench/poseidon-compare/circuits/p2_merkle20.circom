pragma circom 2.2.2;

// Full 20-level Merkle membership proof, structurally identical to
// p1_merkle20.circom (same MultiMux1 left/right selection, same fixed
// depth, same public root output) with only the per-level hash primitive
// swapped: circomlib Poseidon(2) -> Poseidon2 in "compression mode"
// (t=2, out = perm(left,right)[0] + left), the exact construction TACEO's
// own audited binary_merkle_root.circom uses per level. This isolates the
// hash-primitive delta from any change in tree/proof structure.

include "circomlib/circuits/mux1.circom";
include "../vendor/poseidon2/poseidon2.circom";

template P2_Merkle20() {
    signal input leaf;
    signal input pathElements[20];
    signal input pathIndices[20];
    signal output root;

    signal nodes[21];
    nodes[0] <== leaf;

    component mux[20];
    component perm[20];
    signal permResult[20][2];

    for (var i = 0; i < 20; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== nodes[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== nodes[i];
        mux[i].s <== pathIndices[i];

        perm[i] = Poseidon2(2);
        perm[i].in[0] <== mux[i].out[0];
        perm[i].in[1] <== mux[i].out[1];
        permResult[i] <== perm[i].out;
        nodes[i + 1] <== permResult[i][0] + mux[i].out[0];
    }

    root <== nodes[20];
}

component main = P2_Merkle20();
