pragma circom 2.1.0;
include "../node_modules/circomlib/circuits/mux1.circom";
template ProbeMultiMux1() {
    signal input c[2][2];
    signal input s;
    signal output out[2];
    component m = MultiMux1(2);
    m.c[0][0] <== c[0][0];
    m.c[0][1] <== c[0][1];
    m.c[1][0] <== c[1][0];
    m.c[1][1] <== c[1][1];
    m.s <== s;
    out[0] <== m.out[0];
    out[1] <== m.out[1];
}
component main {public [c, s]} = ProbeMultiMux1();
