pragma circom 2.1.0;
include "../node_modules/circomlib/circuits/poseidon.circom";
template ProbePoseidon2() {
    signal input inputs[2];
    signal output out;
    component h = Poseidon(2);
    h.inputs[0] <== inputs[0];
    h.inputs[1] <== inputs[1];
    out <== h.out;
}
component main {public [inputs]} = ProbePoseidon2();
