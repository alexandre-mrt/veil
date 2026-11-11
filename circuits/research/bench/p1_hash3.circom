pragma circom 2.1.0;
// RESEARCH micro-benchmark: one instance of Poseidon(3), constraint count only.
include "../../node_modules/circomlib/circuits/poseidon.circom";
component main = Poseidon(3);
