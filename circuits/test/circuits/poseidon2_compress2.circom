pragma circom 2.2.2;

include "../../node_modules/@taceo/circom-lib/circuits/poseidon2.circom";

// The exact 2-to-1 compression construction used by
// templates/merkle_proof_poseidon2.circom's per-level hash:
//   out = Poseidon2Permutation([left, right])[0] + left
// Exposed standalone so poseidon2.test.mjs can verify it against a JS
// re-implementation of the same formula over the @taceo/poseidon2 raw
// permutation, independent of the Merkle swap-and-mux logic.
template Compress2() {
    signal input left;
    signal input right;
    signal output out;

    component perm = Poseidon2(2);
    perm.in[0] <== left;
    perm.in[1] <== right;

    out <== perm.out[0] + left;
}

component main {public [left, right]} = Compress2();
