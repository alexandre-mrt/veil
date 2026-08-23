pragma circom 2.2.2;

// Shape A: 2-to-1 compression, no domain tag — matches circuits/templates/merkle_proof.circom's
// per-level hash, called depth=20 times per transfer/compliance proof.
include "../../../../../circuits/node_modules/circomlib/circuits/poseidon.circom";

template ShapeAPoseidon() {
    signal input left;
    signal input right;
    signal output out;

    component h = Poseidon(2);
    h.inputs[0] <== left;
    h.inputs[1] <== right;
    out <== h.out;
}

component main = ShapeAPoseidon();
