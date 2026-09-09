pragma circom 2.2.2;

include "@taceo/circom-lib/circuits/compression.circom";

// Drop-in replacement for circomlib's `Poseidon(nInputs)` (node_modules/circomlib/circuits/poseidon.circom),
// built on top of @taceo/circom-lib's `Poseidon2Sponge`. Same interface — `signal input inputs[nInputs]`,
// `signal output out` — same semantics (absorb all nInputs elements, including any domain tag Veil already
// places at inputs[0], squeeze one field element), so it can replace a `Poseidon(n)` component 1:1 anywhere
// in the codebase without changing call sites beyond the component's type name.
//
// The one real difference from circomlib's Poseidon: circomlib supports every t = nInputs+1 (any arity).
// Poseidon2's optimized external linear layer (Horizen Labs' reference construction, matched by
// @taceo/circom-lib) is only defined for t in {2, 3, 4, 8, 12, 16} — see poseidon2_constants.circom's
// `assert(t == 2 || t == 3 || t == 4 || t == 8 || t == 12 || t == 16)`. `poseidon2Width` below picks the
// smallest supported t that still fits nInputs in a single permutation's rate (t-1); Veil's own arities
// (2, 3, 4, 5) all fit in one permutation this way, at t = 3, 4, 8, 8 respectively. There is no supported
// t = 5 or t = 6, so the two dominant hashes (Poseidon(4), Poseidon(5)) pay for a wider, padded permutation
// (t = 8) instead of a tight one. See the experiment writeup for what that costs.
function poseidon2Width(nInputs) {
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

template Poseidon2Hash(nInputs) {
    signal input inputs[nInputs];
    signal output out;

    var t = poseidon2Width(nInputs);
    // ds = 0: no extra domain separation beyond what Veil's own call sites already pass as inputs[0]
    // (the numeric domain tags in transfer.circom/compliance.circom/withdraw.circom's comments). Adding a
    // second, sponge-level domain tag on top would change the hash's meaning, not just its cost, which
    // would make this an unfair comparison against the baseline.
    out <== Poseidon2Sponge(nInputs, t)(inputs, 0);
}
