pragma circom 2.1.0;

// Isolation fixture — a single Num2Bits(64) instance (the 64-bit range checks
// repeated across all three circuits). See poseidon2.circom for why this exists.

include "../../node_modules/circomlib/circuits/bitify.circom";

component main = Num2Bits(64);
