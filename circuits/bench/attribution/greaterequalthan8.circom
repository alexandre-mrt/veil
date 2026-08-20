pragma circom 2.1.0;

// Isolation fixture — a single GreaterEqThan(8) instance (compliance.circom's
// kycCheck). See poseidon2.circom for why this exists.

include "../../node_modules/circomlib/circuits/comparators.circom";

component main = GreaterEqThan(8);
