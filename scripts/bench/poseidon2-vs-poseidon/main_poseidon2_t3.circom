pragma circom 2.0.0;

include "../../../circuits/templates/poseidon2_t3.circom";

// Wraps the Poseidon2 (t=3) permutation for direct constraint-count
// comparison against circomlib's Poseidon(2) (also t=3). See
// docs/research/2026-08-04-poseidon2-vs-poseidon.md.
component main {public [in]} = Poseidon2Permutation3();
