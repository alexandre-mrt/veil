pragma circom 2.1.0;
include "poseidon2_perm.circom";

// Poseidon2 bare permutation, BN254, t = 3 (bkomuves/hash-circuits, vendored).
component main = Permutation();
