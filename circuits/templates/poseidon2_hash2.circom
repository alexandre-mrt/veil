pragma circom 2.2.2;

include "../node_modules/@taceo/circom-lib/circuits/poseidon2.circom";

// Arity-2 Poseidon2 sponge hash, wired to match circomlib's Poseidon(2)
// capacity-element convention: state[0] is the zero capacity element,
// state[1..2] are the two rate elements (the inputs), and the digest is
// state[0] after one Poseidon2(t=3) permutation. Matching that convention
// (rather than e.g. truncating a different output element, or seeding the
// capacity with something other than 0) is what makes this a drop-in
// replacement for every `Poseidon(2)` call site: same input order, same
// digest position, only the permutation itself has changed.
template Poseidon2Hash2() {
    signal input inputs[2];
    signal output out;

    signal state[3];
    state[0] <== 0;
    state[1] <== inputs[0];
    state[2] <== inputs[1];

    component perm = Poseidon2(3);
    perm.in <== state;

    out <== perm.out[0];
}
