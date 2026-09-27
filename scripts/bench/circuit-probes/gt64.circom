pragma circom 2.1.0;
include "circomlib/circuits/comparators.circom";

// GreaterThan(64) - transfer.circom C4, withdraw.circom C3.
template ProbeGT64() {
    signal input a;
    signal input b;
    component c = GreaterThan(64);
    c.in[0] <== a;
    c.in[1] <== b;
}
component main = ProbeGT64();
