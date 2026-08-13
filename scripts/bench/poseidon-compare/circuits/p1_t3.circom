pragma circom 2.1.0;

// Micro-benchmark: one circomlib Poseidon(2) call (t=3 internal state), two
// signal inputs, no domain tag — matches templates/merkle_proof.circom's
// per-level hasher exactly.

include "circomlib/circuits/poseidon.circom";

template P1_T3() {
    signal input a;
    signal input b;
    signal output out;

    component h = Poseidon(2);
    h.inputs[0] <== a;
    h.inputs[1] <== b;
    out <== h.out;
}

component main = P1_T3();
