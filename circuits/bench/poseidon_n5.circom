pragma circom 2.2.2;

// Benchmark-only: bare circomlib Poseidon(5) permutation, matching the arity
// used for compliance.circom's leafHash (credential Merkle leaf). Not wired
// into any protocol circuit.
include "circomlib/circuits/poseidon.circom";

component main = Poseidon(5);
