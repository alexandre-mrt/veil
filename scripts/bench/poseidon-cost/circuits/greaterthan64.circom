pragma circom 2.1.0;

include "circomlib/circuits/comparators.circom";

// Isolates GreaterThan(64), used in transfer.circom (txAmount > 0) and
// withdraw.circom (withdrawAmount > 0).
template Bench() {
    signal input in[2];
    signal output out;
    component c = GreaterThan(64);
    c.in[0] <== in[0];
    c.in[1] <== in[1];
    out <== c.out;
}

component main = Bench();
