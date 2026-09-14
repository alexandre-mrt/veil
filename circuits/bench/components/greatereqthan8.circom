pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/comparators.circom";

// Isolated GreaterEqThan(8) — compliance.circom's kycLevel >= requiredKycLevel.
template GreaterEqThan8Bench() {
    signal input a;
    signal input b;
    signal output out;
    component c = GreaterEqThan(8);
    c.in[0] <== a;
    c.in[1] <== b;
    out <== c.out;
}

component main = GreaterEqThan8Bench();
