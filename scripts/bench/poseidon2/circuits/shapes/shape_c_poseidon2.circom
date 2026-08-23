pragma circom 2.2.2;

include "../lib/poseidon2_hash.circom";

template ShapeCPoseidon2() {
    signal input msg0;
    signal input msg1;
    signal input msg2;
    signal output out;

    out <== Poseidon2Hash(3, 4, 7)([msg0, msg1, msg2]);
}

component main = ShapeCPoseidon2();
