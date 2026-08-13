pragma circom 2.1.0;

// Micro-benchmark: one circomlib Poseidon(4) call (t=5 internal state),
// one compile-time domain-tag constant + three signal inputs — matches
// transfer.circom's oldHash/newHash/nfHash (C1, C2, C10) and
// withdraw.circom's commHash/changeHash/nfHash.

include "circomlib/circuits/poseidon.circom";

template P1_T5() {
    signal input a;
    signal input b;
    signal input c;
    signal output out;

    component h = Poseidon(4);
    h.inputs[0] <== 1; // domain tag, constant, mirrors production usage
    h.inputs[1] <== a;
    h.inputs[2] <== b;
    h.inputs[3] <== c;
    out <== h.out;
}

component main = P1_T5();
