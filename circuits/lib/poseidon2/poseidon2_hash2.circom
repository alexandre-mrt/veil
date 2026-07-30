pragma circom 2.2.2;

include "poseidon2.circom";

// Poseidon2Hash2 — 2-to-1 hash built on the Poseidon2(t=3) permutation.
//
// Sponge convention matches circomlib's Poseidon(nInputs) exactly (see
// node_modules/circomlib/circuits/poseidon.circom, template Poseidon / PoseidonEx):
// capacity element is fixed to 0, the two inputs occupy the rate, and the output is the
// first element of the permuted state. Only the permutation (Poseidon -> Poseidon2)
// changes; the hash construction around it is unchanged, so this is a like-for-like
// drop-in replacement for circomlib's Poseidon(2) at 2-ary Merkle nodes.
template Poseidon2Hash2() {
    signal input in[2];
    signal output out;

    component perm = Poseidon2(3);
    perm.in[0] <== 0;
    perm.in[1] <== in[0];
    perm.in[2] <== in[1];

    out <== perm.out[0];
}
