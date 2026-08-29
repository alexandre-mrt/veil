pragma circom 2.2.2;

// Benchmark-only: bare circomlib Poseidon(3) permutation, matching the arity
// used for compliance.circom's nullifier/contextId hashes and transfer.circom's
// txAmountHash. Not wired into any protocol circuit.
include "circomlib/circuits/poseidon.circom";

component main = Poseidon(3);
