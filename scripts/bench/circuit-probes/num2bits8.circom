pragma circom 2.1.0;
include "circomlib/circuits/bitify.circom";

// Isolates a single Num2Bits(8) range check (used 2x in compliance.circom,
// SKILL-002/M-01 fixes for kycLevel / requiredKycLevel).
template Probe() {
    signal input a;
    component b = Num2Bits(8);
    b.in <== a;
}
component main = Probe();
