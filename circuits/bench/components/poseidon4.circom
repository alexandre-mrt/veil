pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";

// Isolated Poseidon(4) instance — e.g. transfer.circom's oldHash/newHash/nfHash,
// withdraw.circom's commHash/changeHash/nfHash.
template Poseidon4Bench() {
    signal input a;
    signal input b;
    signal input c;
    signal input d;
    signal output out;
    component h = Poseidon(4);
    h.inputs[0] <== a;
    h.inputs[1] <== b;
    h.inputs[2] <== c;
    h.inputs[3] <== d;
    out <== h.out;
}

component main = Poseidon4Bench();
