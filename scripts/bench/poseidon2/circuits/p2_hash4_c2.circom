pragma circom 2.1.0;
include "poseidon2_sponge.circom";

// Poseidon2 sponge hash of 4 field elements, capacity 2 (rate 1) — upstream default.
component main = PoseidonSponge(3, 2, 4, 1);
