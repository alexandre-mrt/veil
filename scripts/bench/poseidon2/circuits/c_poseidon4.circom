pragma circom 2.1.0;
include "circomlib/circuits/poseidon.circom";

// circomlib Poseidon, arity 4 (t = 5) — as used in production circuits.
component main = Poseidon(4);
