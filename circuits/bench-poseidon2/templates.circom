pragma circom 2.2.2;

include "circomlib/circuits/poseidon.circom";
include "@taceo/circom-lib/circuits/compression.circom";

// Wraps circomlib's Poseidon(n) exactly as Veil's production circuits call it today
// (transfer.circom, withdraw.circom, compliance.circom, templates/merkle_proof.circom):
// n field elements in, one field element out, t = n + 1 internally.
template PoseidonHashN(n) {
    signal input in[n];
    signal output out;
    out <== Poseidon(n)(in);
}

// Wraps @taceo/circom-lib's Poseidon2Sponge(n, t, DS): n field elements in (rate t-1,
// one permutation call since n <= t-1 for every arity benched here), one field element
// out. DS sits in the sponge's capacity element, not in the rate -- see the report for
// why that changes the domain-tag analysis relative to circomlib's convention (where
// Veil bakes the domain tag into in[0]).
template Poseidon2HashN(n, t) {
    signal input in[n];
    signal output out;
    // Bench-only domain separator (arbitrary constant, distinct per call site below via
    // the entry file name -- not a claim about what a production tag would encode).
    var DS = 0x5665696c2d506f736569646f6e32; // ASCII "Veil-Poseidon2"
    out <== Poseidon2Sponge(n, t, DS)(in);
}
