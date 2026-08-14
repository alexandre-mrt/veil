pragma circom 2.1.0;

include "../../../circuits/node_modules/circomlib/circuits/bitify.circom";

template Gadget() {
    signal input in;
    signal output out[8];

    component b = Num2Bits(8);
    b.in <== in;
    for (var i = 0; i < 8; i++) {
        out[i] <== b.out[i];
    }
}

component main = Gadget();
