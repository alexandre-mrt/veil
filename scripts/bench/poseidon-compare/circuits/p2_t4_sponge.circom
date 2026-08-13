pragma circom 2.2.2;

// Micro-benchmark: Poseidon2Sponge(N=3, T=4, DS) — three signal inputs,
// domain tag in the capacity element, one t=4 permutation. Compare against
// p1_t5.circom (circomlib Poseidon(4): t=5 permutation).

include "../vendor/poseidon2/compression.circom";

template P2_T4Sponge() {
    signal input a;
    signal input b;
    signal input c;
    signal output out;

    out <== Poseidon2Sponge(3, 4, 1)([a, b, c]); // DS=1, same tag as transfer.circom's commitment hashes
}

component main = P2_T4Sponge();
