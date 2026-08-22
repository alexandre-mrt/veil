pragma circom 2.1.0;
include "../../../templates/merkle_proof.circom";

// Isolated depth-20 Merkle path microbenchmark on the ORIGINAL circomlib
// Poseidon(2) node hash — the exact template transfer.circom and
// compliance.circom both use for C0/C2. Paired with merkle20_poseidon2.circom.
// See docs/research/2026-08-22-poseidon2-hash-swap.md.
component main = MerkleProof(20);
