pragma circom 2.1.0;

// Isolation fixture — a single LessEqThan(64) instance (transfer.circom's
// ltThreshold, withdraw.circom's amountCheck). See poseidon2.circom for why
// this exists.

include "../../node_modules/circomlib/circuits/comparators.circom";

component main = LessEqThan(64);
