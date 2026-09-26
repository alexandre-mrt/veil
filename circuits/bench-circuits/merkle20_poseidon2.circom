pragma circom 2.1.0;

include "../templates/merkle_proof_poseidon2.circom";

// Isolated benchmark: the same depth-20 Merkle authentication-path check as
// merkle20_poseidon.circom, but with Poseidon2 (compression mode) as the
// hasher. See docs/research/2026-09-26-poseidon2-merkle-path.md.
component main {public [leaf, pathElements, pathIndices]} = MerkleProofPoseidon2(20);
