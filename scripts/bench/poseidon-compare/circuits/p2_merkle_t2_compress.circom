pragma circom 2.2.2;

// Micro-benchmark: one Poseidon2 permutation in "compression mode" (t=2,
// output = perm(a,b)[0] + a) — the exact construction TACEO's own
// binary_merkle_root.circom uses per Merkle level. Two signal inputs, no
// domain tag, directly comparable to p1_t3.circom (circomlib Poseidon(2)).

include "../vendor/poseidon2/poseidon2.circom";

template P2_MerkleT2Compress() {
    signal input a;
    signal input b;
    signal output out;

    signal result[2] <== Poseidon2(2)([a, b]);
    out <== result[0] + a;
}

component main = P2_MerkleT2Compress();
