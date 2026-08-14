pragma circom 2.1.0;

include "../../../circuits/node_modules/circomlib/circuits/poseidon.circom";

template Gadget() {
    signal input in0;
    signal input in1;
    signal input in2;
    signal input in3;
    signal output out;

    component h = Poseidon(4);
    h.inputs[0] <== in0;
    h.inputs[1] <== in1;
    h.inputs[2] <== in2;
    h.inputs[3] <== in3;
    out <== h.out;
}

component main = Gadget();
