pragma circom 2.1.0;
include "merkle_proof.circom";

// One level of the PRODUCTION Merkle template (bit check + MultiMux1 + Poseidon(2)).
component main = MerkleProof(1);
