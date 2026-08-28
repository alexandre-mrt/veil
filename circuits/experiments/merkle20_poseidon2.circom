pragma circom 2.1.0;

include "../templates/merkle_proof_poseidon2.circom";

// Isolated benchmark: the Poseidon2-compression variant of merkle20_poseidon1.circom,
// same depth (20), same interface. See
// docs/research/2026-08-28-poseidon2-merkle-hash.md.
component main = MerkleProofPoseidon2(20);
