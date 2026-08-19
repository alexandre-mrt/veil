pragma circom 2.2.2;

include "../hash.circom";

// t = 6 has no native Poseidon2 parameters in the vendored library either. Same t=8 padding
// fallback as poseidon2_n4_padded_t8.circom. Matches Poseidon(5) (compliance credential leaf
// hash).
component main = Poseidon2HashPadded(5, 8);
