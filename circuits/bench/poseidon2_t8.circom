pragma circom 2.2.2;

// Benchmark-only: bare Poseidon2(8) permutation (TACEO's audited circom port,
// pinned via @taceo/circom-lib). Poseidon2's defined state widths are
// {2,3,4,8,12,16} — there is no t=5 or t=6, so a capacity-1 fixed hash of 4 or
// 5 field elements (Poseidon(4), Poseidon(5) in the current codebase) has no
// same-width Poseidon2 counterpart and must round up to the next defined width,
// t=8. This circuit stands in for both: rate = t-1 = 7 comfortably covers
// both a 4-input and a 5-input hash in a single permutation call, so the
// constraint cost is identical for both replacements. See the research report
// for why this makes the comparison conservative (Poseidon2 pays for 8 full
// state elements of work per call even though only 4-5 carry real input).
// Not wired into any protocol circuit.
include "@taceo/circom-lib/circuits/poseidon2.circom";

component main = Poseidon2(8);
