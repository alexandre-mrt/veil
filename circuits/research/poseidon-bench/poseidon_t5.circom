pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";

// Isolated wrapper: circomlib's Poseidon(4) (t=5) — the arity transfer.circom's
// oldCommitment/newCommitment/nullifier hashes use (domain tag + 3 values).
component main = Poseidon(4);
