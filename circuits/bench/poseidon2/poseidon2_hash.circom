pragma circom 2.2.2;

include "../../node_modules/@taceo/circom-lib/circuits/poseidon2.circom";

// Poseidon2Hash(nInputs) — a fixed-input-length hash built on the raw Poseidon2(t) permutation,
// mirroring circomlib's Poseidon(nInputs)/PoseidonEx convention exactly so the two are drop-in
// comparable at the same call site:
//   state = [0, in[0], ..., in[nInputs-1]]   (capacity/domain slot first, initialised to 0)
//   state' = Poseidon2(t) permutation, t = nInputs + 1
//   out = state'[0]                          (single-element squeeze)
// This is the same "permutation with a fixed capacity element, squeeze one word" construction
// circomlib's Poseidon(nInputs) uses (see node_modules/circomlib/circuits/poseidon.circom,
// PoseidonEx: initialState at index 0, out <== pEx.out[0]) — not a novel sponge mode.
//
// Only t = nInputs + 1 in {2, 3, 4, 8, 12, 16} is valid: those are the only state sizes
// @taceo/circom-lib ships published round constants for (see poseidon2_constants.circom),
// matching the widths the Poseidon2 paper (https://eprint.iacr.org/2023/323) gives concrete
// parameters for. Veil's own Poseidon(4)/Poseidon(5) call sites (t=5, t=6) fall outside this set —
// see circuits/bench/poseidon2/README.md.
template Poseidon2Hash(nInputs) {
    signal input in[nInputs];
    signal output out;

    var t = nInputs + 1;
    signal state[t];
    state[0] <== 0;
    for (var i = 0; i < nInputs; i++) {
        state[i + 1] <== in[i];
    }

    component perm = Poseidon2(t);
    perm.in <== state;
    out <== perm.out[0];
}
