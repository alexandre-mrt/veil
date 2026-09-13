pragma circom 2.2.2;

// Baseline: circomlib's current Poseidon, 3 inputs (t=4 internal state) — the same construction
// as transfer.circom's txAmountHash and compliance.circom's nfHash/ctxHash (all Poseidon(3)).
include "../../node_modules/circomlib/circuits/poseidon.circom";

template PoseidonCheck(nInputs) {
    signal input in[nInputs];
    signal input expectedHash;

    component h = Poseidon(nInputs);
    h.inputs <== in;
    expectedHash === h.out;
}

component main {public [expectedHash]} = PoseidonCheck(3);
