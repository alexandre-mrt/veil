pragma circom 2.1.0;
include "../node_modules/circomlib/circuits/bitify.circom";
template ProbeNum2Bits64() {
    signal input in;
    signal output out[64];
    component b = Num2Bits(64);
    b.in <== in;
    for (var i = 0; i < 64; i++) { out[i] <== b.out[i]; }
}
component main {public [in]} = ProbeNum2Bits64();
