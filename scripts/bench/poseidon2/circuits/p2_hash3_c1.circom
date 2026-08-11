pragma circom 2.1.0;
include "poseidon2_sponge.circom";

// Poseidon2 sponge hash of 3 field elements, capacity 1 (rate 2) —
// the same ~128-bit security level circomlib Poseidon targets.
component main = PoseidonSponge(3, 1, 3, 1);
