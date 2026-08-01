pragma circom 2.1.0;
include "../node_modules/circomlib/circuits/poseidon.circom";
template ProbePoseidon4() {
    signal input inputs[4];
    signal output out;
    component h = Poseidon(4);
    h.inputs[0] <== inputs[0];
    h.inputs[1] <== inputs[1];
    h.inputs[2] <== inputs[2];
    h.inputs[3] <== inputs[3];
    out <== h.out;
}
component main {public [inputs]} = ProbePoseidon4();
