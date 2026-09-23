pragma circom 2.1.0;

include "templates/merkle_proof.circom";

// Same template as merkleproof20.circom at a shallower depth, to check
// whether non-linear constraint cost actually scales linearly with Merkle
// depth (it should — each level is one more Poseidon(2) + MultiMux1(2) call).
component main = MerkleProof(10);
