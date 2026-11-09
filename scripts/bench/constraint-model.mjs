// constraint-model.mjs — ANALYTIC MODEL, NOT A MEASUREMENT.
// Predicts R1CS non-linear constraints for circomlib Poseidon and candidate variants, then
// cross-checks the model against the *measured* 2026-07-22 totals in docs/research/BASELINE.md.
// Run: node scripts/bench/constraint-model.mjs
// Every figure printed here is UNMEASURED until re-checked with `circom --r1cs` + `snarkjs r1cs info`.

// Round counts: read from circuits/node_modules/circomlib/circuits/poseidon.circom (N_ROUNDS_P), R_F = 8.
const N_ROUNDS_P = [56, 57, 56, 60, 60, 63, 64, 63, 60, 66, 60, 65, 70, 60, 64, 68];
const RF = 8;
// x^5 S-box = 3 multiplications (Sigma template). Linear layers / constant mults cost 0 non-linear
// constraints in R1CS. Model: sboxes = RF*t + RP - 1 (matches the commonly cited 240 for Poseidon(2) — from
// memory of public circomlib numbers, itself unverified here).
const poseidon = (nIn) => { const t = nIn + 1; return 3 * (RF * t + N_ROUNDS_P[t - 2] - 1); };
// Poseidon2 t=3, x^5: RF=8, RP=56 (Poseidon2 paper parameter table, from memory — unverified).
const poseidon2_t3 = () => 3 * (RF * 3 + 56 - 1);

const P = poseidon;
console.log("per-instance non-linear constraints (model)");
for (const n of [2, 3, 4, 5]) console.log(`  circomlib Poseidon(${n}) : ${P(n)}`);
console.log(`  Poseidon2 t=3          : ${poseidon2_t3()}`);

// Cross-check vs measured baseline (non-linear column).
const measured = { transfer: 6470, compliance: 6057, withdraw: 1465 };
const hashes = {
  transfer:   20 * P(2) + 3 * P(4) + P(3),                 // merkle(20) + old/new/nullifier + txAmountHash
  compliance: 20 * P(2) + P(5) + 2 * P(3),                 // merkle(20) + leaf + nullifier + contextId
  withdraw:   3 * P(4) + P(2),                             // commitment/change/nullifier + recipientHash
};
console.log("\ncross-check: modelled hash cost vs measured non-linear total");
for (const k of Object.keys(measured))
  console.log(`  ${k.padEnd(10)} hash model ${hashes[k]}  measured total ${measured[k]}  residual (range checks, mux, misc) ${measured[k] - hashes[k]}`);

// Candidate A: swap Poseidon -> Poseidon2 (t=3 Merkle only; other arities' Poseidon2 params not modelled).
const merkleNow = 20 * (P(2) + 2 /*MultiMux1(2)*/ + 1 /*bool check*/);
const merkleP2  = 20 * (poseidon2_t3() + 3);
console.log("\nCandidate A: Poseidon2 Merkle (depth 20, arity 2)");
console.log(`  now ${merkleNow}  poseidon2 ${merkleP2}  delta ${merkleP2 - merkleNow}`);

// Candidate B: arity-4 Merkle, depth 10 (same 2^20 anonymity set). Selection logic ~ 12 nonlinear/level (assumed).
const SEL = 12;
const merkle4 = 10 * (P(4) + SEL);
console.log("\nCandidate B: arity-4 Merkle, depth 10 (2^20 leaves)");
console.log(`  now ${merkleNow}  arity-4 ${merkle4}  delta ${merkle4 - merkleNow} (${(100*(merkle4-merkleNow)/merkleNow).toFixed(1)}% of Merkle path)`);
for (const k of ["transfer", "compliance"]) {
  const after = measured[k] + (merkle4 - merkleNow);
  console.log(`  ${k}: ${measured[k]} -> ~${after} non-linear (${(100*(after-measured[k])/measured[k]).toFixed(1)}%)  [UNMEASURED]`);
}
