pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";

// Matches templates/merkle_proof.circom's per-level hash: 2 inputs, no domain tag.
template OldMerkle2() {
    signal input in[2];
    signal output out;
    component h = Poseidon(2);
    h.inputs[0] <== in[0];
    h.inputs[1] <== in[1];
    out <== h.out;
}

component main = OldMerkle2();
