pragma circom 2.2.2;

// Benchmark-only: bare circomlib Poseidon(4) permutation, matching the arity
// used for transfer.circom's oldCommitment/newCommitment/nullifier and
// withdraw.circom's commitment/changeCommitment/nullifier — the single most
// common Poseidon call in the protocol (7 instances across the two most
// expensive circuits). Not wired into any protocol circuit.
include "circomlib/circuits/poseidon.circom";

component main = Poseidon(4);
