pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/bitify.circom";

// Isolated Num2Bits(64) range check — one of the 64-bit range proofs used
// throughout transfer.circom / compliance.circom / withdraw.circom.
template Num2Bits64Bench() {
    signal input in;
    signal output out[64];
    component c = Num2Bits(64);
    c.in <== in;
    for (var i = 0; i < 64; i++) {
        out[i] <== c.out[i];
    }
}

component main = Num2Bits64Bench();
