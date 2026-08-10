pragma circom 2.2.2;

// Benchmark harness: depth-20 Merkle proof using the PRODUCTION Poseidon(2)
// (circomlib) template, unmodified. Counterpart: merkle_poseidon2.circom.
// See docs/research/2026-08-10-poseidon2-merkle.md.

include "../../../circuits/templates/merkle_proof.circom";

component main = MerkleProof(20);
