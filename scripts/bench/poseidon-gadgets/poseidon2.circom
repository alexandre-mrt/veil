pragma circom 2.1.0;

// Isolated single-instance gadget for constraint-decomposition benchmarking.
// See scripts/bench/README.md for how this is used.

include "../../../circuits/node_modules/circomlib/circuits/poseidon.circom";

template Gadget() {
    signal input in0;
    signal input in1;
    signal output out;

    component h = Poseidon(2);
    h.inputs[0] <== in0;
    h.inputs[1] <== in1;
    out <== h.out;
}

component main = Gadget();
