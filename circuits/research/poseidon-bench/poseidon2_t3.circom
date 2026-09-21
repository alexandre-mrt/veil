pragma circom 2.1.0;

include "./poseidon2_t3_template.circom";

// Standalone wrapper around Poseidon2T3 (see poseidon2_t3_template.circom for the
// permutation itself and its caveats) for isolated single-hash measurement.
component main = Poseidon2T3();
