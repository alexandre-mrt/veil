pragma circom 2.1.0;
include "circomlib/circuits/poseidon.circom";

// Isolates a single Poseidon(2) call (arity used by MerkleProof's per-level
// hash, and withdraw.circom's recipient-hash C9) for constraint attribution.
template Probe() {
    signal input a;
    signal input b;
    signal output out;
    component h = Poseidon(2);
    h.inputs[0] <== a;
    h.inputs[1] <== b;
    out <== h.out;
}
component main = Probe();
