pragma circom 2.1.0;

include "circomlib/circuits/comparators.circom";

// Isolates GreaterEqThan(64) — compliance.circom's expiryCheck.
template Bench() {
    signal input in[2];
    signal output out;
    component c = GreaterEqThan(64);
    c.in[0] <== in[0];
    c.in[1] <== in[1];
    out <== c.out;
}

component main = Bench();
