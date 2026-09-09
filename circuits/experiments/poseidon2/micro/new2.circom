pragma circom 2.2.2;
include "../templates/poseidon2_hash.circom";
template New2() {
    signal input inputs[2];
    signal output out;
    component h = Poseidon2Hash(2);
    for (var i = 0; i < 2; i++) { h.inputs[i] <== inputs[i]; }
    out <== h.out;
}
component main = New2();
