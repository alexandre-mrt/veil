pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";

// Isolated wrapper: circomlib's Poseidon(2) (t=3), the exact template
// templates/merkle_proof.circom calls once per Merkle level (20x per transfer /
// compliance proof). Benchmark-only — measures this one gadget's R1CS cost alone.
component main = Poseidon(2);
