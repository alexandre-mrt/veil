pragma circom 2.2.2;

include "node_modules/@taceo/circom-lib/circuits/poseidon2.circom";

// Poseidon2Hash(nInputs) — drop-in replacement for circomlib's Poseidon(nInputs)
// hash interface (component X = Poseidon(n); X.inputs[i] <== ...; X.out), built
// on top of @taceo/circom-lib@0.9.0's Poseidon2(t) *permutation* primitive, which
// only ships round constants for t in {2,3,4,8,12,16} — no native t=5,6,7.
//
// Sponge convention, matching circomlib's Poseidon(nInputs) exactly where widths
// coincide: state[0] = capacity (0), state[1..nInputs] = inputs, squeeze state[0]
// after one permutation call.
//
// EXPERIMENTAL / BENCHMARK ONLY — not a proposed production replacement. See
// docs/research/2026-09-01-poseidon2-constraint-delta.md and this directory's
// README.md.
//
// Where nInputs+1 is not a natively supported width (5, 6, 7), this zero-pads up
// to the next supported width (8). That zero-padding is naive: it does not encode
// input arity in the padded slots, so it is only safe because every call site in
// Veil's circuits uses a fixed, compile-time-constant nInputs per template
// instantiation — a real production sponge over variable-length input would need
// a domain-separated padding scheme (e.g. injecting nInputs into an unused
// capacity/padding slot) to rule out cross-arity collisions in general. Flagged
// explicitly in the writeup's Approach and Verdict sections.
template Poseidon2Hash(nInputs) {
    signal input inputs[nInputs];
    signal output out;

    var t = nInputs + 1;
    var actualT = t;
    if (t == 5 || t == 6 || t == 7) {
        actualT = 8;
    }

    signal state[actualT];
    state[0] <== 0;
    for (var i = 0; i < nInputs; i++) {
        state[i + 1] <== inputs[i];
    }
    for (var i = nInputs + 1; i < actualT; i++) {
        state[i] <== 0;
    }

    component perm = Poseidon2(actualT);
    perm.in <== state;
    out <== perm.out[0];
}
