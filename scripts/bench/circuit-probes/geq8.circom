pragma circom 2.1.0;
include "circomlib/circuits/comparators.circom";

// GreaterEqThan(8) - compliance.circom C5 (KYC level check).
template ProbeGEQ8() {
    signal input a;
    signal input b;
    component c = GreaterEqThan(8);
    c.in[0] <== a;
    c.in[1] <== b;
}
component main = ProbeGEQ8();
