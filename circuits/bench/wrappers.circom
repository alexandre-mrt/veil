pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/@taceo/circom-lib/circuits/poseidon2.circom";

// One-shot hash wrapper around circomlib's Poseidon(nInputs), matching how
// transfer.circom / withdraw.circom / compliance.circom actually call it:
// capacity element fixed at 0 (circomlib's own convention, see PoseidonEx),
// nInputs real field elements, single output.
template Poseidon1Bench(nInputs) {
    signal input in[nInputs];
    signal output out;
    component h = Poseidon(nInputs);
    for (var i = 0; i < nInputs; i++) {
        h.inputs[i] <== in[i];
    }
    out <== h.out;
}

// Same one-shot-hash semantics built on top of taceo's raw Poseidon2(t)
// permutation: state[0] = capacity (0), state[1..nReal] = real inputs,
// remaining slots up to t zero-padded, digest = state[0] after the
// permutation. t must be one of taceo's supported widths (2,3,4,8,12,16);
// nReal + 1 (capacity) <= t.
template Poseidon2Bench(t, nReal) {
    signal input in[nReal];
    signal output out;
    component p = Poseidon2(t);
    p.in[0] <== 0;
    for (var i = 0; i < nReal; i++) {
        p.in[i + 1] <== in[i];
    }
    for (var i = nReal + 1; i < t; i++) {
        p.in[i] <== 0;
    }
    out <== p.out[0];
}
