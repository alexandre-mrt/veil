pragma circom 2.1.0;
include "circomlib/circuits/poseidon.circom";

// circomlib Poseidon, arity 3 (t = 4) — as used in production circuits.
component main = Poseidon(3);
