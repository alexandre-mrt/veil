pragma circom 2.1.0;
include "../node_modules/circomlib/circuits/poseidon.circom";
template ProbePoseidon5() {
    signal input inputs[5];
    signal output out;
    component h = Poseidon(5);
    h.inputs[0] <== inputs[0];
    h.inputs[1] <== inputs[1];
    h.inputs[2] <== inputs[2];
    h.inputs[3] <== inputs[3];
    h.inputs[4] <== inputs[4];
    out <== h.out;
}
component main {public [inputs]} = ProbePoseidon5();
