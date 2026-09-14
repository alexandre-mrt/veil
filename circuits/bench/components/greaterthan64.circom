pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/comparators.circom";

// Isolated GreaterThan(64) — transfer.circom's txAmount > 0, withdraw.circom's
// withdrawAmount > 0.
template GreaterThan64Bench() {
    signal input a;
    signal input b;
    signal output out;
    component c = GreaterThan(64);
    c.in[0] <== a;
    c.in[1] <== b;
    out <== c.out;
}

component main = GreaterThan64Bench();
