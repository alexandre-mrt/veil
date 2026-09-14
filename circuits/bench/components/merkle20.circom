pragma circom 2.1.0;

include "../../templates/merkle_proof.circom";

// Full depth-20 MerkleProof template in isolation, as used by both
// transfer.circom and compliance.circom (20x Poseidon(2) + 20x MultiMux1(2)).
component main = MerkleProof(20);
