pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";

// Isolates a single Poseidon(3) call (arity used by transfer.circom's txHash
// and compliance.circom's nfHash/ctxHash).
template Bench() {
    signal input in[3];
    signal output out;
    component h = Poseidon(3);
    h.inputs[0] <== in[0];
    h.inputs[1] <== in[1];
    h.inputs[2] <== in[2];
    out <== h.out;
}

component main = Bench();
