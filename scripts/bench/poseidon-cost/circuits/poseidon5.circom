pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";

// Isolates a single Poseidon(5) call — compliance.circom's leafHash, the
// widest Poseidon instance in the protocol.
template Bench() {
    signal input in[5];
    signal output out;
    component h = Poseidon(5);
    h.inputs[0] <== in[0];
    h.inputs[1] <== in[1];
    h.inputs[2] <== in[2];
    h.inputs[3] <== in[3];
    h.inputs[4] <== in[4];
    out <== h.out;
}

component main = Bench();
