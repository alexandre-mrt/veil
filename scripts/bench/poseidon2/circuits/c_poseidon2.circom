pragma circom 2.1.0;
include "circomlib/circuits/poseidon.circom";

// circomlib Poseidon, arity 2 (t = 3) — as used in production circuits.
component main = Poseidon(2);
