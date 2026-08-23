pragma circom 2.2.2;

include "poseidon2.circom";

template PermCheckT3() {
    signal input in[3];
    signal output out[3];
    out <== Poseidon2(3)(in);
}

component main = PermCheckT3();
