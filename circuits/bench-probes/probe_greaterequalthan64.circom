pragma circom 2.1.0;
include "../node_modules/circomlib/circuits/comparators.circom";
template ProbeGreaterEqThan64() {
    signal input in[2];
    signal output out;
    component c = GreaterEqThan(64);
    c.in[0] <== in[0];
    c.in[1] <== in[1];
    out <== c.out;
}
component main {public [in]} = ProbeGreaterEqThan64();
