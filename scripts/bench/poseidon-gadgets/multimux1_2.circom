pragma circom 2.1.0;

include "../../../circuits/node_modules/circomlib/circuits/mux1.circom";

template Gadget() {
    signal input c00;
    signal input c01;
    signal input c10;
    signal input c11;
    signal input s;
    signal output out0;
    signal output out1;

    component m = MultiMux1(2);
    m.c[0][0] <== c00;
    m.c[0][1] <== c01;
    m.c[1][0] <== c10;
    m.c[1][1] <== c11;
    m.s <== s;
    out0 <== m.out[0];
    out1 <== m.out[1];
}

component main = Gadget();
