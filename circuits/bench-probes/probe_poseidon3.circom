pragma circom 2.1.0;
include "../node_modules/circomlib/circuits/poseidon.circom";
template ProbePoseidon3() {
    signal input inputs[3];
    signal output out;
    component h = Poseidon(3);
    h.inputs[0] <== inputs[0];
    h.inputs[1] <== inputs[1];
    h.inputs[2] <== inputs[2];
    out <== h.out;
}
component main {public [inputs]} = ProbePoseidon3();
