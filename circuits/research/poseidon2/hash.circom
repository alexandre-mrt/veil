pragma circom 2.2.2;

include "vendor/poseidon2.circom";

// Thin "hash" wrapper around the vendored Poseidon2(t) permutation, matching circomlib's
// Poseidon(nInputs) convention exactly so constraint counts are comparable apples-to-apples:
// state[0] is a zero capacity element, inputs occupy state[1..nInputs], output is the
// permuted state[0] (a single field element). See circomlib's `template Poseidon` in
// node_modules/circomlib/circuits/poseidon.circom for the construction being mirrored.
//
// Only defined for nInputs+1 in the vendored circuit's supported state sizes {2,3,4,8,12,16}.
template Poseidon2Hash(nInputs) {
    signal input inputs[nInputs];
    signal output out;

    var t = nInputs + 1;
    assert(t == 2 || t == 3 || t == 4 || t == 8 || t == 12 || t == 16);

    signal state[t];
    state[0] <== 0;
    for (var i = 0; i < nInputs; i++) {
        state[i + 1] <== inputs[i];
    }

    component perm = Poseidon2(t);
    perm.in <== state;

    out <== perm.out[0];
}

// Poseidon2Hash but zero-padded up to a fixed state size `tFixed`, for arities the vendored
// library has no native round constants for (Veil needs t=5 and t=6; the library only ships
// {2,3,4,8,12,16}). Padding with zero field elements after the real inputs is a standard,
// safe way to reuse a wider permutation for a narrower arity: the padding is public and fixed
// per template instantiation, so it can't be used to create input-output collisions across
// different nInputs values as long as callers never mix nInputs for the same tFixed (which
// Veil's fixed per-field-name usage sites always satisfy).
template Poseidon2HashPadded(nInputs, tFixed) {
    signal input inputs[nInputs];
    signal output out;

    assert(tFixed == 2 || tFixed == 3 || tFixed == 4 || tFixed == 8 || tFixed == 12 || tFixed == 16);
    assert(nInputs + 1 <= tFixed);

    signal state[tFixed];
    state[0] <== 0;
    for (var i = 0; i < nInputs; i++) {
        state[i + 1] <== inputs[i];
    }
    for (var i = nInputs + 1; i < tFixed; i++) {
        state[i] <== 0;
    }

    component perm = Poseidon2(tFixed);
    perm.in <== state;

    out <== perm.out[0];
}
