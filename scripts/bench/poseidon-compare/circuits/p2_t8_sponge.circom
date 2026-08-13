pragma circom 2.2.2;

// Micro-benchmark: Poseidon2Sponge(N=4, T=8, DS) — four signal inputs,
// domain tag in the capacity element, one t=8 permutation (the smallest
// state Poseidon2 supports for a 4-element rate; TACEO's library only
// ships t in {2,3,4,8,12,16}, so a 5-real-input hash pads the rate from
// 4 used slots up to 7 available, wasting 3). Compare against p1_t6.circom
// (circomlib Poseidon(5): t=6 permutation, no padding waste, but no
// available Poseidon2 state size matches t=6 either).

include "../vendor/poseidon2/compression.circom";

template P2_T8Sponge() {
    signal input a;
    signal input b;
    signal input c;
    signal input d;
    signal output out;

    out <== Poseidon2Sponge(4, 8, 4)([a, b, c, d]); // DS=4, same tag as compliance.circom's leafHash
}

component main = P2_T8Sponge();
