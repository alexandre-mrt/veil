pragma circom 2.1.0;

include "../../../circuits/node_modules/circomlib/circuits/bitify.circom";

// Isolates one Num2Bits(8) range check — used twice in compliance.circom
// for kycLevel / requiredKycLevel wraparound guards.
component main {public [in]} = Num2Bits(8);
