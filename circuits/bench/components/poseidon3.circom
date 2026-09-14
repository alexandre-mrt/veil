pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";

// Isolated Poseidon(3) instance — e.g. transfer.circom's txAmountHash,
// compliance.circom's nfHash / ctxHash.
template Poseidon3Bench() {
    signal input a;
    signal input b;
    signal input c;
    signal output out;
    component h = Poseidon(3);
    h.inputs[0] <== a;
    h.inputs[1] <== b;
    h.inputs[2] <== c;
    out <== h.out;
}

component main = Poseidon3Bench();
