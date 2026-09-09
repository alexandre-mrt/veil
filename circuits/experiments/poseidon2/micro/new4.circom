pragma circom 2.2.2;
include "../templates/poseidon2_hash.circom";
template New4() {
    signal input inputs[4];
    signal output out;
    component h = Poseidon2Hash(4);
    for (var i = 0; i < 4; i++) { h.inputs[i] <== inputs[i]; }
    out <== h.out;
}
component main = New4();
