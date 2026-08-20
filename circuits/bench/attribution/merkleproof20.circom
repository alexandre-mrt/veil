pragma circom 2.1.0;

// Isolation fixture — the full MerkleProof(20) template used by transfer.circom
// (C0) and compliance.circom (C2): 20x Poseidon(2) + 20x MultiMux1(2). Compiled
// standalone so its total can be checked against 20x the poseidon2.circom count
// plus a (near-zero) mux contribution.

include "../../templates/merkle_proof.circom";

component main {public [leaf]} = MerkleProof(20);
