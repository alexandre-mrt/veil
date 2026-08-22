pragma circom 2.1.0;

include "../vendor/poseidon2/poseidon2.circom";

// Poseidon2Hash(nInputs) — drop-in replacement for circomlib's Poseidon(nInputs)
// (node_modules/circomlib/circuits/poseidon.circom), same sponge shape:
//   state = [0, inputs[0], ..., inputs[nInputs-1]]   (capacity element = 0, t = nInputs+1)
//   state' = Poseidon2Permutation(state)
//   out = state'[0]
// only the round function is swapped from Poseidon to Poseidon2. This preserves
// circomlib's convention of passing the domain-separation tag as inputs[0] (a rate
// element), so callers do not need to change their preimage layout — see
// docs/research/2026-08-22-poseidon2-hash-swap.md for why this construction (not a
// capacity-IV domain tag) was chosen.
//
// Only nInputs in {2, 3} are supported (t = 3, 4), because the vendored
// poseidon2_constants.circom only carries verified round constants for
// t in {2,3,4,8,12,16}. t=5 and t=6 — needed for Veil's Poseidon(4) commitment/
// nullifier hashes and the Poseidon(5) credential-leaf hash — are NOT available;
// see the report for why those call sites are intentionally left on Poseidon(1).
template Poseidon2Hash(nInputs) {
    assert(nInputs == 2 || nInputs == 3);

    signal input inputs[nInputs];
    signal output out;

    var t = nInputs + 1;
    signal state[t];
    state[0] <== 0;
    for (var i = 0; i < nInputs; i++) {
        state[i + 1] <== inputs[i];
    }

    component perm = Poseidon2(t);
    perm.in <== state;

    out <== perm.out[0];
}
