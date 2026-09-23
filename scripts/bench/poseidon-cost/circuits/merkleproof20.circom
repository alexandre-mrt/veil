pragma circom 2.1.0;

include "templates/merkle_proof.circom";

// Isolates the full depth-20 Poseidon Merkle membership template used by
// both transfer.circom (C0) and compliance.circom (C2) — unmodified, the
// real template from circuits/templates/merkle_proof.circom, not a copy.
component main = MerkleProof(20);
