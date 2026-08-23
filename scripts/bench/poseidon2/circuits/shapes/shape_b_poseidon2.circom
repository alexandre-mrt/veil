pragma circom 2.2.2;

include "../lib/poseidon2_hash.circom";

template ShapeBPoseidon2() {
    signal input msg0;
    signal input msg1;
    signal output out;

    out <== Poseidon2Hash(2, 3, 7)([msg0, msg1]);
}

component main = ShapeBPoseidon2();
