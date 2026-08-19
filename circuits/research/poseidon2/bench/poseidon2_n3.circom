pragma circom 2.2.2;

include "../hash.circom";

// t = 4, natively supported by the vendored Poseidon2 — matches Poseidon(3) (txAmountHash,
// credential nullifier/context hashes).
component main = Poseidon2Hash(3);
