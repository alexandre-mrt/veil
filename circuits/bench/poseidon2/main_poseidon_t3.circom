pragma circom 2.2.2;

// Baseline: circomlib's current Poseidon, 2 inputs (t=3 internal state) — the same construction
// as withdraw.circom's recipientHash (Poseidon(2)). Constrains a public expectedHash against the
// hash of two private inputs, so a forged expectedHash is a real constraint violation, not just an
// unused output — see test/poseidon2.test.mjs PB-NEG-1/2.
include "../../node_modules/circomlib/circuits/poseidon.circom";

template PoseidonCheck(nInputs) {
    signal input in[nInputs];
    signal input expectedHash;

    component h = Poseidon(nInputs);
    h.inputs <== in;
    expectedHash === h.out;
}

component main {public [expectedHash]} = PoseidonCheck(2);
