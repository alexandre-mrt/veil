pragma circom 2.1.0;
include "circomlib/circuits/poseidon.circom";

// circomlib Poseidon, arity 5 (t = 6) — as used in production circuits.
component main = Poseidon(5);
