pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/bitify.circom";

// Isolated Num2Bits(8) range check — compliance.circom's kycLevel / requiredKycLevel.
template Num2Bits8Bench() {
    signal input in;
    signal output out[8];
    component c = Num2Bits(8);
    c.in <== in;
    for (var i = 0; i < 8; i++) {
        out[i] <== c.out[i];
    }
}

component main = Num2Bits8Bench();
