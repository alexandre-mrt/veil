pragma circom 2.1.0;
include "../node_modules/circomlib/circuits/comparators.circom";
template ProbeLessEqThan64() {
    signal input in[2];
    signal output out;
    component c = LessEqThan(64);
    c.in[0] <== in[0];
    c.in[1] <== in[1];
    out <== c.out;
}
component main {public [in]} = ProbeLessEqThan64();
