pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/comparators.circom";

// Isolated LessEqThan(64) — transfer.circom's cumNew <= threshold,
// withdraw.circom's withdrawAmount <= cumulativeOld.
template LessEqThan64Bench() {
    signal input a;
    signal input b;
    signal output out;
    component c = LessEqThan(64);
    c.in[0] <== a;
    c.in[1] <== b;
    out <== c.out;
}

component main = LessEqThan64Bench();
