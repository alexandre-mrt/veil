pragma circom 2.1.0;

// Isolation fixture — a single Num2Bits(8) instance (compliance.circom's
// kycBits/reqKycBits range checks). See poseidon2.circom for why this exists.

include "../../node_modules/circomlib/circuits/bitify.circom";

component main = Num2Bits(8);
