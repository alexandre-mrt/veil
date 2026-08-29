pragma circom 2.2.2;

// Benchmark-only: bare Poseidon2(4) permutation (TACEO's audited circom port,
// pinned via @taceo/circom-lib), directly comparable to Poseidon(3) — both use
// state width t = nInputs + 1 = 4. This is the arity independently cross-checked
// tonight against two unrelated BN254 Poseidon2 implementations (@zkpassport/poseidon2,
// @platus-xyz/poseidon2) before any constraint count in this experiment was cited
// — see the research report. Not wired into any protocol circuit.
include "@taceo/circom-lib/circuits/poseidon2.circom";

component main = Poseidon2(4);
