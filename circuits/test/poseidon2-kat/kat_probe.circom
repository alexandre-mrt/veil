pragma circom 2.2.2;

// Known-answer-test probe: exposes Poseidon2Sponge at every T value Veil's
// shadow circuits use (T=2,3,4,8), so its output can be cross-checked
// against an independent JS re-implementation of the same sponge
// construction before any production circuit trusts it.

include "@taceo/circom-lib/circuits/compression.circom";

template SpongeProbe(N, T, DS) {
    signal input in[N];
    signal output out;
    out <== Poseidon2Sponge(N, T, DS)(in);
}

component main = SpongeProbe(3, 4, 1);
