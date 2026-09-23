pragma circom 2.1.0;

include "circomlib/circuits/comparators.circom";

// Isolates GreaterEqThan(8) — compliance.circom's kycCheck.
template Bench() {
    signal input in[2];
    signal output out;
    component c = GreaterEqThan(8);
    c.in[0] <== in[0];
    c.in[1] <== in[1];
    out <== c.out;
}

component main = Bench();
