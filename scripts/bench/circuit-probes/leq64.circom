pragma circom 2.1.0;
include "circomlib/circuits/comparators.circom";

// LessEqThan(64) - transfer.circom C9, withdraw.circom C5.
template ProbeLEQ64() {
    signal input a;
    signal input b;
    component c = LessEqThan(64);
    c.in[0] <== a;
    c.in[1] <== b;
}
component main = ProbeLEQ64();
