pragma circom 2.2.2;

include "../hash.circom";

// t = 3, natively supported by the vendored Poseidon2 — matches Poseidon(2) (merkle sibling
// hash, recipientHash).
component main = Poseidon2Hash(2);
