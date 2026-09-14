pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/comparators.circom";

// Isolated GreaterEqThan(64) — compliance.circom's expiryEpoch >= currentEpoch.
template GreaterEqThan64Bench() {
    signal input a;
    signal input b;
    signal output out;
    component c = GreaterEqThan(64);
    c.in[0] <== a;
    c.in[1] <== b;
    out <== c.out;
}

component main = GreaterEqThan64Bench();
