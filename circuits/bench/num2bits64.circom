pragma circom 2.1.0;

// Isolated gadget benchmark — see scripts/bench/gadget-constraints.sh.
include "../node_modules/circomlib/circuits/bitify.circom";

component main = Num2Bits(64);
