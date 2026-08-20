pragma circom 2.1.0;

// Isolation fixture — a single Poseidon(5) instance (compliance.circom's
// leafHash). See poseidon2.circom for why this exists.

include "../../node_modules/circomlib/circuits/poseidon.circom";

component main = Poseidon(5);
