pragma circom 2.1.0;
include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

template MerkleLevel() {
    signal input node;
    signal input pathElement;
    signal input pathIndex;
    signal output out;

    pathIndex * (1 - pathIndex) === 0;

    component mux = MultiMux1(2);
    mux.c[0][0] <== node;
    mux.c[0][1] <== pathElement;
    mux.c[1][0] <== pathElement;
    mux.c[1][1] <== node;
    mux.s <== pathIndex;

    component hasher = Poseidon(2);
    hasher.inputs[0] <== mux.out[0];
    hasher.inputs[1] <== mux.out[1];
    out <== hasher.out;
}

component main = MerkleLevel();
