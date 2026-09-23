pragma circom 2.1.0;

include "circomlib/circuits/comparators.circom";

// Isolates LessEqThan(64), used in transfer.circom (cumulativeNew <=
// threshold) and withdraw.circom (withdrawAmount <= cumulativeOld).
template Bench() {
    signal input in[2];
    signal output out;
    component c = LessEqThan(64);
    c.in[0] <== in[0];
    c.in[1] <== in[1];
    out <== c.out;
}

component main = Bench();
