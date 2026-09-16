pragma circom 2.1.0;

include "./poseidon2.circom";

// Wrappers that expose the Poseidon2 output as a *constrained* public claim,
// for the negative test in test/poseidon2-microbench.test.mjs: feeding a
// witness whose claimedOut does not match the real permutation output must
// fail witness generation (the R1CS constrains claimedOut === realOut, so a
// malicious/incorrect witness is unsatisfiable, exactly like circomlib's
// Poseidon(2)/Poseidon(3) equality checks already used throughout
// transfer.circom / compliance.circom / withdraw.circom, e.g. `oldCommitment
// === oldHash.out`).
template Poseidon2Hash2Checked() {
    signal input inputs[2];
    signal input claimedOut;

    component h = Poseidon2Hash2();
    h.inputs[0] <== inputs[0];
    h.inputs[1] <== inputs[1];
    claimedOut === h.out;
}

template Poseidon2Hash3Checked() {
    signal input inputs[3];
    signal input claimedOut;

    component h = Poseidon2Hash3();
    h.inputs[0] <== inputs[0];
    h.inputs[1] <== inputs[1];
    h.inputs[2] <== inputs[2];
    claimedOut === h.out;
}
