pragma circom 2.1.0;

// Isolation fixture — a single GreaterThan(64) instance (transfer.circom's
// gtZero, withdraw.circom's gtZero). See poseidon2.circom for why this exists.

include "../../node_modules/circomlib/circuits/comparators.circom";

component main = GreaterThan(64);
