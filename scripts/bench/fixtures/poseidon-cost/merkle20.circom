pragma circom 2.1.0;
// Resolved via the compiler's -l/--lib flag against circuits/, so this stays
// valid regardless of where this fixture file itself lives on disk.
include "templates/merkle_proof.circom";
component main = MerkleProof(20);
