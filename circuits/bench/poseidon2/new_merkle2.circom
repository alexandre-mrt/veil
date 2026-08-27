pragma circom 2.2.2;

include "@taceo/circom-lib/circuits/compression.circom";

// Poseidon2 equivalent of old_merkle2.circom: 2 data inputs, capacity element
// holds DS=0 (no domain tag) — matches the current no-tag Merkle level hash.
// T=3 (rate 2, capacity 1) is a supported Poseidon2 state size.
template NewMerkle2() {
    signal input in[2];
    signal output out;
    out <== Poseidon2Sponge(2, 3, 0)(in);
}

component main = NewMerkle2();
