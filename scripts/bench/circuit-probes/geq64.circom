pragma circom 2.1.0;
include "circomlib/circuits/comparators.circom";

// GreaterEqThan(64) - compliance.circom C4 (expiry check).
template ProbeGEQ64() {
    signal input a;
    signal input b;
    component c = GreaterEqThan(64);
    c.in[0] <== a;
    c.in[1] <== b;
}
component main = ProbeGEQ64();
