pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";

// Matches withdraw.circom's recipient hash: Poseidon(2) with domain tag 8 as
// one of the two inputs (1 real data value, tag packed into the rate).
template OldRecipient2() {
    signal input data;
    signal output out;
    component h = Poseidon(2);
    h.inputs[0] <== 8;
    h.inputs[1] <== data;
    out <== h.out;
}

component main = OldRecipient2();
