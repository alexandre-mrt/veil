pragma circom 2.1.0;
// RESEARCH micro-benchmark: one instance of MerkleProof(20), constraint count only.
include "../../templates/merkle_proof.circom";
component main = MerkleProof(20);
