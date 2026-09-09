pragma circom 2.2.2;
include "../templates/poseidon2_hash.circom";
template New5() {
    signal input inputs[5];
    signal output out;
    component h = Poseidon2Hash(5);
    for (var i = 0; i < 5; i++) { h.inputs[i] <== inputs[i]; }
    out <== h.out;
}
component main = New5();
