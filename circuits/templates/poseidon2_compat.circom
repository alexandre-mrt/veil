pragma circom 2.2.2;

include "@taceo/circom-lib/circuits/compression.circom";

// Poseidon2Hash — drop-in replacement for circomlib's Poseidon(nInputs), backed by the
// Poseidon2 permutation (@taceo/circom-lib, audited for TACEO:OPRF) instead of the original
// Poseidon. Same external interface (`inputs[nInputs]` in, `out` out) so every call site in
// Veil's circuits keeps its existing domain-tag-as-inputs[0] scheme unchanged — only the
// underlying hash primitive changes. See docs/research/2026-07-29-poseidon2-migration.md for
// why this exists and what it measures.
//
// Internally: a single-permutation Poseidon2 sponge (rate T-1, one zero capacity element,
// DS=0 since domain separation already happens via inputs[0]). T is the smallest supported
// Poseidon2 state size (2, 3, 4, 8, 12, 16) whose rate (T-1) fits nInputs in one permutation
// call — Veil never hashes more than 5 inputs at once, so this never needs more than one
// permutation.
template Poseidon2Hash(nInputs) {
    signal input inputs[nInputs];
    signal output out;

    var t = poseidon2HashWidth(nInputs);
    out <== Poseidon2Sponge(nInputs, t, 0)(inputs);
}

function poseidon2HashWidth(nInputs) {
    if (nInputs <= 1) {
        return 2;
    } else if (nInputs <= 2) {
        return 3;
    } else if (nInputs <= 3) {
        return 4;
    } else if (nInputs <= 7) {
        return 8;
    } else if (nInputs <= 11) {
        return 12;
    } else {
        return 16;
    }
}
