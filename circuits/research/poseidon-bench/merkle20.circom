pragma circom 2.1.0;

include "../../templates/merkle_proof.circom";

// Isolated wrapper: the exact, unmodified production MerkleProof(20) template
// (templates/merkle_proof.circom), standalone so its full R1CS cost — 20 chained
// Poseidon(2) calls — can be measured in one shot instead of derived by subtraction.
component main = MerkleProof(20);
