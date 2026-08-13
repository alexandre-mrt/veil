pragma circom 2.1.0;

// Micro-benchmark: one circomlib Poseidon(3) call (t=4 internal state),
// one compile-time domain-tag constant + two signal inputs — matches
// transfer.circom's txAmountHash (C11) / compliance.circom's nfHash, ctxHash.

include "circomlib/circuits/poseidon.circom";

template P1_T4() {
    signal input a;
    signal input b;
    signal output out;

    component h = Poseidon(3);
    h.inputs[0] <== 3; // domain tag, constant, mirrors production usage
    h.inputs[1] <== a;
    h.inputs[2] <== b;
    out <== h.out;
}

component main = P1_T4();
