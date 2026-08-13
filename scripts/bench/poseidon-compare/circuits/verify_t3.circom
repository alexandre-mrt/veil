pragma circom 2.2.2;

// Correctness check only (not used in constraint-count measurements): raw
// Poseidon2(3) permutation with the full output state exposed, so it can be
// diffed against @taceo/poseidon2's JS reference for the same input.

include "../vendor/poseidon2/poseidon2.circom";

template VerifyT3() {
    signal input in[3];
    signal output out[3];
    out <== Poseidon2(3)(in);
}

component main = VerifyT3();
