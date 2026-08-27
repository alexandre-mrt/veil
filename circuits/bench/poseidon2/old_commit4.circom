pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";

// Matches transfer.circom / withdraw.circom's commitment and nullifier
// hashes: Poseidon(4), domain tag packed into the rate alongside 3 real
// data values (e.g. cumulative, randomness, userSecret).
template OldCommit4() {
    signal input data[3];
    signal output out;
    component h = Poseidon(4);
    h.inputs[0] <== 1;
    h.inputs[1] <== data[0];
    h.inputs[2] <== data[1];
    h.inputs[3] <== data[2];
    out <== h.out;
}

component main = OldCommit4();
