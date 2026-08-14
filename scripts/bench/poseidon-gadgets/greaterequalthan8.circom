pragma circom 2.1.0;

include "../../../circuits/node_modules/circomlib/circuits/comparators.circom";

template Gadget() {
    signal input in0;
    signal input in1;
    signal output out;

    component c = GreaterEqThan(8);
    c.in[0] <== in0;
    c.in[1] <== in1;
    out <== c.out;
}

component main = Gadget();
