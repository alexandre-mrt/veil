pragma circom 2.1.0;
include "circomlib/circuits/bitify.circom";

// Isolates a single Num2Bits(64) range check (used 4x in transfer.circom,
// 3x in compliance.circom, 4x in withdraw.circom).
template Probe() {
    signal input a;
    component b = Num2Bits(64);
    b.in <== a;
}
component main = Probe();
