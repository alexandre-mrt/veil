pragma circom 2.1.0;
include "poseidon2_perm.circom";

// Poseidon2 2-to-1 Merkle compression (truncated t = 3 permutation, zero capacity IV).
component main = Compression();
