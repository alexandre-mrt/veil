pragma circom 2.2.2;

// Shape D: 1 domain tag + 4 message elements — matches compliance.circom's leafHash
// (Poseidon(5), tag 4). The one Veil hash site whose message length needs a Poseidon2
// state size wider than the natural t=5 (Poseidon2 has no t=5 parameter set; this shape
// steps up to the next supported size, t=8, using only 4 of its 7 rate slots).
include "../../../../../circuits/node_modules/circomlib/circuits/poseidon.circom";

template ShapeDPoseidon() {
    signal input msg0;
    signal input msg1;
    signal input msg2;
    signal input msg3;
    signal output out;

    component h = Poseidon(5);
    h.inputs[0] <== 7;
    h.inputs[1] <== msg0;
    h.inputs[2] <== msg1;
    h.inputs[3] <== msg2;
    h.inputs[4] <== msg3;
    out <== h.out;
}

component main = ShapeDPoseidon();
