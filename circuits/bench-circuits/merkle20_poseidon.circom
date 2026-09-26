pragma circom 2.1.0;

include "../templates/merkle_proof.circom";

// Isolated benchmark: a depth-20 Merkle authentication-path check using the
// circuit's *current* hasher (circomlib Poseidon(2), sponge mode), with
// nothing else in the circuit. Lets the Poseidon-vs-Poseidon2 constraint
// delta be measured directly, without transfer.circom's other 8 constraints
// (commitments, nullifier, range checks) as noise.
// See docs/research/2026-09-26-poseidon2-merkle-path.md.
component main {public [leaf, pathElements, pathIndices]} = MerkleProof(20);
