pragma circom 2.2.2;

// Micro-benchmark: Poseidon2Sponge(N=2, T=3, DS) — two signal inputs, domain
// tag folded into the sponge's capacity element at compile time instead of
// consuming a rate slot. One t=3 permutation. Compare against p1_t4.circom
// (circomlib Poseidon(3): domain tag as a rate element, t=4 permutation) —
// this is the "adopt Poseidon2's own domain-separation idiom" comparison,
// not a naive same-arity swap.

include "../vendor/poseidon2/compression.circom";

template P2_T3Sponge() {
    signal input a;
    signal input b;
    signal output out;

    out <== Poseidon2Sponge(2, 3, 3)([a, b]); // DS=3, same tag as transfer.circom's txAmountHash
}

component main = P2_T3Sponge();
