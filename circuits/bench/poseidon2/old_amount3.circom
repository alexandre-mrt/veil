pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";

// Matches transfer.circom's txAmountHash: Poseidon(3), domain tag 3 packed
// into the rate alongside 2 real data values (txAmount, salt).
template OldAmount3() {
    signal input data[2];
    signal output out;
    component h = Poseidon(3);
    h.inputs[0] <== 3;
    h.inputs[1] <== data[0];
    h.inputs[2] <== data[1];
    out <== h.out;
}

component main = OldAmount3();
