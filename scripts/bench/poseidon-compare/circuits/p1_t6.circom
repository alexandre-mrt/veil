pragma circom 2.1.0;

// Micro-benchmark: one circomlib Poseidon(5) call (t=6 internal state),
// one compile-time domain-tag constant + four signal inputs — matches
// compliance.circom's leafHash (C1).

include "circomlib/circuits/poseidon.circom";

template P1_T6() {
    signal input a;
    signal input b;
    signal input c;
    signal input d;
    signal output out;

    component h = Poseidon(5);
    h.inputs[0] <== 4; // domain tag, constant, mirrors production usage
    h.inputs[1] <== a;
    h.inputs[2] <== b;
    h.inputs[3] <== c;
    h.inputs[4] <== d;
    out <== h.out;
}

component main = P1_T6();
