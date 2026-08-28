pragma circom 2.1.0;

include "../node_modules/@taceo/circom-lib/circuits/poseidon2.circom";

// Isolated permutation-correctness check: exposes Poseidon2(2)'s raw output
// so it can be cross-checked against the @taceo/poseidon2 JS reference
// implementation for the same inputs. See
// docs/research/2026-08-28-poseidon2-merkle-hash.md.
component main = Poseidon2(2);
