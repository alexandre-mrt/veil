pragma circom 2.2.2;

include "../lib/poseidon2_hash.circom";

template ShapeDPoseidon2() {
    signal input msg0;
    signal input msg1;
    signal input msg2;
    signal input msg3;
    signal output out;

    out <== Poseidon2Hash(4, 8, 7)([msg0, msg1, msg2, msg3]);
}

component main = ShapeDPoseidon2();
