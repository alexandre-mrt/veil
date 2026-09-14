pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";

// Isolated Poseidon(5) instance — compliance.circom's leafHash.
template Poseidon5Bench() {
    signal input a;
    signal input b;
    signal input c;
    signal input d;
    signal input e;
    signal output out;
    component h = Poseidon(5);
    h.inputs[0] <== a;
    h.inputs[1] <== b;
    h.inputs[2] <== c;
    h.inputs[3] <== d;
    h.inputs[4] <== e;
    out <== h.out;
}

component main = Poseidon5Bench();
