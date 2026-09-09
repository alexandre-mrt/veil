pragma circom 2.1.0;
include "../../../node_modules/circomlib/circuits/poseidon.circom";
template Old4() {
    signal input inputs[4];
    signal output out;
    component h = Poseidon(4);
    for (var i = 0; i < 4; i++) { h.inputs[i] <== inputs[i]; }
    out <== h.out;
}
component main = Old4();
