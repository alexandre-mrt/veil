pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";

// Isolates a single Poseidon(2) call (arity used by withdraw.circom's recipHash
// and by MerkleProof's per-level hasher) so its standalone R1CS cost can be
// measured directly, independent of everything else in the real circuits.
template Bench() {
    signal input in[2];
    signal output out;
    component h = Poseidon(2);
    h.inputs[0] <== in[0];
    h.inputs[1] <== in[1];
    out <== h.out;
}

component main = Bench();
