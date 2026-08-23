pragma circom 2.2.2;

// Shape B: 1 domain tag + 2 message elements — matches transfer.circom's txHash
// (Poseidon(3), tag 3) and compliance.circom's nfHash/ctxHash (Poseidon(3), tags 5/6).
include "../../../../../circuits/node_modules/circomlib/circuits/poseidon.circom";

template ShapeBPoseidon() {
    signal input msg0;
    signal input msg1;
    signal output out;

    component h = Poseidon(3);
    h.inputs[0] <== 7; // domain tag (value is arbitrary for a constraint-count benchmark)
    h.inputs[1] <== msg0;
    h.inputs[2] <== msg1;
    out <== h.out;
}

component main = ShapeBPoseidon();
