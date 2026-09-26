pragma circom 2.2.2;

include "../../node_modules/@taceo/circom-lib/circuits/poseidon2.circom";

// Raw Poseidon2 permutation, state size t=2, exposed directly for
// cross-checking against the @taceo/poseidon2 JS reference implementation
// (same publisher, explicit Rust-crate parity claim) in poseidon2.test.mjs.
component main {public [in]} = Poseidon2(2);
