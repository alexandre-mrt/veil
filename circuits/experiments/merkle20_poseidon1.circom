pragma circom 2.1.0;

include "../templates/merkle_proof.circom";

// Isolated benchmark: a standalone depth-20 Merkle inclusion proof using the
// current production node hash (circomlib Poseidon(2)). Exists only to
// measure the Merkle sub-circuit's own constraint cost in isolation, without
// the rest of transfer.circom/compliance.circom around it. See
// docs/research/2026-08-28-poseidon2-merkle-hash.md.
component main = MerkleProof(20);
