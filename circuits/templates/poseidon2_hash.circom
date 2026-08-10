pragma circom 2.2.2;

include "../node_modules/@taceo/circom-lib/circuits/poseidon2.circom";

// Thin sponge wrapper around @taceo/circom-lib's raw Poseidon2(t) permutation,
// matching circomlib's Poseidon(nInputs) convention exactly: state[0] is a
// zero capacity element, state[1..t-1] are the rate (the hash inputs, already
// including any domain tag as state[1]), output is the permuted capacity slot.
// Caller assembles `state` (so zero-padding for unsupported arities is visible
// at the call site, not hidden in this wrapper).
template Poseidon2Hash(t) {
    signal input state[t];
    signal output out;

    signal permuted[t] <== Poseidon2(t)(state);
    out <== permuted[0];
}
