pragma circom 2.2.2;

// Candidate: Poseidon2, 3 inputs (t=4), same call-site shape as main_poseidon_t4.circom —
// the direct comparison point for transfer.circom's txAmountHash / compliance.circom's
// nfHash & ctxHash (all Poseidon(3)).
include "poseidon2_hash.circom";

template Poseidon2Check(nInputs) {
    signal input in[nInputs];
    signal input expectedHash;

    component h = Poseidon2Hash(nInputs);
    h.in <== in;
    expectedHash === h.out;
}

component main {public [expectedHash]} = Poseidon2Check(3);
