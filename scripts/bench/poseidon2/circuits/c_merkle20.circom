pragma circom 2.1.0;
include "merkle_proof.circom";

// The PRODUCTION depth-20 Merkle membership proof (circuits/templates/merkle_proof.circom).
component main = MerkleProof(20);
