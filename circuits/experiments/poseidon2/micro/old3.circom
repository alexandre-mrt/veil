pragma circom 2.1.0;
include "../../../node_modules/circomlib/circuits/poseidon.circom";
template Old3() {
    signal input inputs[3];
    signal output out;
    component h = Poseidon(3);
    for (var i = 0; i < 3; i++) { h.inputs[i] <== inputs[i]; }
    out <== h.out;
}
component main = Old3();
