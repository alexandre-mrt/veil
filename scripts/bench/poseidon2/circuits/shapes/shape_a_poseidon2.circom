pragma circom 2.2.2;

include "../lib/poseidon2_hash.circom";

template ShapeAPoseidon2() {
    signal input left;
    signal input right;
    signal output out;

    out <== Poseidon2Compress2()(left, right);
}

component main = ShapeAPoseidon2();
