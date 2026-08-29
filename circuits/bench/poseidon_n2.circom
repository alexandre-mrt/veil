pragma circom 2.2.2;

// Benchmark-only: bare circomlib Poseidon(2) permutation, matching the arity
// used for merkle_proof.circom's Merkle-path hashing and withdraw.circom's
// recipientHash. Not wired into any protocol circuit.
include "circomlib/circuits/poseidon.circom";

component main = Poseidon(2);
