pragma circom 2.2.2;

// Candidate: Poseidon2, 2 inputs (t=3), same call-site shape as main_poseidon_t3.circom —
// the direct comparison point for withdraw.circom's recipientHash (Poseidon(2)).
include "poseidon2_hash.circom";

template Poseidon2Check(nInputs) {
    signal input in[nInputs];
    signal input expectedHash;

    component h = Poseidon2Hash(nInputs);
    h.in <== in;
    expectedHash === h.out;
}

component main {public [expectedHash]} = Poseidon2Check(2);
