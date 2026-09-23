pragma circom 2.1.0;

include "circomlib/circuits/bitify.circom";

// Isolates a single Num2Bits(8) range check (compliance.circom's kycBits /
// reqKycBits).
template Bench() {
    signal input in;
    component b = Num2Bits(8);
    b.in <== in;
}

component main = Bench();
