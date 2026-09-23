pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";

// Isolates a single Poseidon(4) call — the most-used arity in the protocol:
// transfer.circom's oldHash/newHash/nfHash, withdraw.circom's
// commHash/changeHash/nfHash.
template Bench() {
    signal input in[4];
    signal output out;
    component h = Poseidon(4);
    h.inputs[0] <== in[0];
    h.inputs[1] <== in[1];
    h.inputs[2] <== in[2];
    h.inputs[3] <== in[3];
    out <== h.out;
}

component main = Bench();
