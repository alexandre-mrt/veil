pragma circom 2.1.0;

include "../../../circuits/templates/merkle_proof.circom";

// Isolates the full depth-20 Merkle membership template (20x Poseidon(2) +
// 20x MultiMux1(2) path selection) exactly as used by transfer.circom (C0)
// and compliance.circom (C2), to see whether its cost is pure
// 20 * Poseidon(2) or carries additional mux overhead.
component main {public [leaf]} = MerkleProof(20);
