pragma circom 2.1.0;
include "../../../templates/merkle_proof_poseidon2.circom";

// Isolated depth-20 Merkle path microbenchmark on Poseidon2Hash(2). Paired
// with merkle20_poseidon.circom. See
// docs/research/2026-08-22-poseidon2-hash-swap.md.
component main = Poseidon2MerkleProof(20);
