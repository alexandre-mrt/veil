pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";

// Isolated Poseidon(2) instance — measures the constraint cost of a single
// arity-2 hash, e.g. one level of Veil's depth-20 Merkle path (merkle_proof.circom).
template Poseidon2Bench() {
    signal input a;
    signal input b;
    signal output out;
    component h = Poseidon(2);
    h.inputs[0] <== a;
    h.inputs[1] <== b;
    out <== h.out;
}

component main = Poseidon2Bench();
