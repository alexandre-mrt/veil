pragma circom 2.2.2;

include "@taceo/circom-lib/circuits/compression.circom";

// Domain-separation check: same n=4 inputs, ds supplied as a circuit input so a single
// compiled circuit can be re-witnessed with two different domain tags and the outputs
// diffed outside the circuit. See docs/research/2026-08-26-poseidon2-arity-gap.md.
template Poseidon2HashDsInput(n, t) {
    signal input in[n];
    signal input ds;
    signal output out;
    out <== Poseidon2SpongeWithDs(n, t)(in, ds);
}

component main = Poseidon2HashDsInput(4, 8);
