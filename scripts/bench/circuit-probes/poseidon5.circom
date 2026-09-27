pragma circom 2.1.0;
include "circomlib/circuits/poseidon.circom";

// Isolates a single Poseidon(5) call (arity used only by compliance.circom's
// credential-leaf hash: H(4, userSecret, kycLevel, expiryEpoch, issuerId)).
template Probe() {
    signal input a;
    signal input b;
    signal input c;
    signal input d;
    signal input e;
    signal output out;
    component h = Poseidon(5);
    h.inputs[0] <== a;
    h.inputs[1] <== b;
    h.inputs[2] <== c;
    h.inputs[3] <== d;
    h.inputs[4] <== e;
    out <== h.out;
}
component main = Probe();
