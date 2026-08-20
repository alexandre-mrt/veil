pragma circom 2.1.0;

// Isolation fixture for docs/research/2026-08-20-poseidon-constraint-attribution.md —
// a single Poseidon(2) instance (used by MerkleProof's per-level hasher and
// withdraw.circom's recipHash), so its non-linear constraint cost can be read
// directly off `snarkjs r1cs info` instead of inferred from a larger circuit.

include "../../node_modules/circomlib/circuits/poseidon.circom";

component main = Poseidon(2);
