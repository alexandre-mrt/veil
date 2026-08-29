pragma circom 2.2.2;

// Benchmark-only: bare Poseidon2(3) permutation (TACEO's audited circom port,
// pinned via @taceo/circom-lib), directly comparable to Poseidon(2) — both use
// state width t = nInputs + 1 = 3 under the capacity-1 fixed-hash convention
// circomlib's Poseidon() follows. Not wired into any protocol circuit.
include "@taceo/circom-lib/circuits/poseidon2.circom";

component main = Poseidon2(3);
