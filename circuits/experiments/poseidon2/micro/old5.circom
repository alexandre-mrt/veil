pragma circom 2.1.0;
include "../../../node_modules/circomlib/circuits/poseidon.circom";
template Old5() {
    signal input inputs[5];
    signal output out;
    component h = Poseidon(5);
    for (var i = 0; i < 5; i++) { h.inputs[i] <== inputs[i]; }
    out <== h.out;
}
component main = Old5();
