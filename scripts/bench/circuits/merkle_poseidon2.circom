pragma circom 2.2.2;

// Benchmark harness: depth-20 Merkle proof using Poseidon2(3) via
// templates/merkle_proof_poseidon2.circom instead of production Poseidon(2).
// Same sponge construction (capacity-0, rate 2), only the permutation
// differs. Counterpart: merkle_poseidon.circom.
// See docs/research/2026-08-10-poseidon2-merkle.md.

include "../../../circuits/templates/merkle_proof_poseidon2.circom";

component main = MerkleProofPoseidon2(20);
