pragma circom 2.1.0;
include "../../../node_modules/circomlib/circuits/poseidon.circom";
template Old2() {
    signal input inputs[2];
    signal output out;
    component h = Poseidon(2);
    for (var i = 0; i < 2; i++) { h.inputs[i] <== inputs[i]; }
    out <== h.out;
}
component main = Old2();
