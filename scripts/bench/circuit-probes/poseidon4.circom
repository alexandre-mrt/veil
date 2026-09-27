pragma circom 2.1.0;
include "circomlib/circuits/poseidon.circom";

// Isolates a single Poseidon(4) call (arity used by the commitment/nullifier
// hashes in transfer.circom and withdraw.circom — the most-repeated arity
// in the protocol).
template Probe() {
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
component main = Probe();
