pragma circom 2.1.0;

// Isolated gadget benchmark — see scripts/bench/gadget-constraints.sh.
// The exact MerkleProof(20) template used by transfer.circom and
// compliance.circom, compiled alone so its cost can be compared against
// 20x the standalone Poseidon(2) number (bench/poseidon2.circom) — the
// difference is the MultiMux1(2) selector overhead per level.

include "../templates/merkle_proof.circom";

component main = MerkleProof(20);
