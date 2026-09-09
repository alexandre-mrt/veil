pragma circom 2.2.2;
include "../templates/poseidon2_hash.circom";
template New3() {
    signal input inputs[3];
    signal output out;
    component h = Poseidon2Hash(3);
    for (var i = 0; i < 3; i++) { h.inputs[i] <== inputs[i]; }
    out <== h.out;
}
component main = New3();
