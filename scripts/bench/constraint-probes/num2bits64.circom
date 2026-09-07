pragma circom 2.1.0;

include "../../../circuits/node_modules/circomlib/circuits/bitify.circom";

// Isolates one Num2Bits(64) range check — used 3-4x per circuit for the
// 64-bit overflow guards on amounts/cumulatives/epochs.
component main {public [in]} = Num2Bits(64);
