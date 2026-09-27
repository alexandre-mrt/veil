pragma circom 2.1.0;
include "circomlib/circuits/poseidon.circom";

// Isolates a single Poseidon(3) call (arity used by transfer.circom's
// txAmountHash and compliance.circom's nullifier/context-binding hashes).
template Probe() {
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
component main = Probe();
