pragma circom 2.1.0;

include "circomlib/circuits/bitify.circom";

// Isolates a single Num2Bits(64) range check, used four times in
// transfer.circom (C5-C8) and three times in withdraw.circom. Matches the
// real usage pattern: the bit array output is never consumed further.
template Bench() {
    signal input in;
    component b = Num2Bits(64);
    b.in <== in;
}

component main = Bench();
