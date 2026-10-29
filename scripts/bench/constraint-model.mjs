// Analytic R1CS non-linear-constraint model for Veil's circuits.
//
// NOT a measurement: it is a closed-form model, validated against the measured
// non-linear counts in docs/research/BASELINE.md (1,465 / 6,470 / 6,057). Predictions for
// designs that have not been compiled (Poseidon2, 4-ary Merkle) are labelled UNMEASURED.
//
// Usage: node scripts/bench/constraint-model.mjs   (run from repo root, after `npm install` in circuits/)
import { readFileSync } from "node:fs";

// Round-number table read straight from the installed circomlib, not retyped.
const src = readFileSync("circuits/node_modules/circomlib/circuits/poseidon.circom", "utf8");
const table = src.match(/var N_ROUNDS_P\[16\] = \[([^\]]+)\]/)[1].split(",").map(Number);

const SBOX = 3; // circomlib Sigma: in2, in4, out = 3 multiplications
// circomlib Poseidon(n): t = n+1, 8 full rounds, N_ROUNDS_P[t-2] partial rounds
const poseidon = (n) => { const t = n + 1; return SBOX * (8 * t + table[t - 2]); };
// Poseidon2 (HorizenLabs 055bde3, BN254 d=5): R_F=8, R_P=56 for t=3 (verified in repo);
// t=4 R_P=56 is the paper's value, NOT verified here. Linear layers are free in R1CS.
const poseidon2 = (t, rp = 56) => SBOX * (8 * t + rp);

const bits = (n) => n;                 // Num2Bits(n): n constraints
const cmp = (n) => n + 1;              // GreaterThan/LessEqThan/GreaterEqThan(n): Num2Bits(n+1)
const merkleLevel = poseidon(2) + 1 + 2; // bool check + MultiMux1(2) + Poseidon(2)

const D = 20;
const model = {
  withdraw: 3 * poseidon(4) + poseidon(2) + 3 * bits(64) + 2 * cmp(64),
  transfer: D * merkleLevel + 3 * poseidon(4) + poseidon(3) + 4 * bits(64) + 2 * cmp(64),
  compliance: D * merkleLevel + poseidon(5) + 2 * poseidon(3)
    + cmp(64) + cmp(8) + 2 + 1 + 3 * bits(64) + 2 * bits(8),
};
const measured = { withdraw: 1465, transfer: 6470, compliance: 6057 };

console.log("== validation: model vs measured non-linear constraints (BASELINE.md) ==");
for (const k of Object.keys(model))
  console.log(k.padEnd(11), "model", model[k], "measured", measured[k], model[k] === measured[k] ? "EXACT" : "MISMATCH");

console.log("\n== per-instance Poseidon cost (non-linear constraints) ==");
for (const n of [2, 3, 4, 5]) console.log(`Poseidon(${n}) t=${n + 1}:`, poseidon(n));
console.log("Merkle level (bool + mux + Poseidon(2)):", merkleLevel);
console.log("Merkle path depth 20:", D * merkleLevel, `= ${(100 * D * merkleLevel / model.transfer).toFixed(1)}% of transfer non-linear`);

console.log("\n== UNMEASURED prediction A: Poseidon2 swap (domain tag in capacity slot) ==");
const p2 = {
  withdraw: 3 * poseidon2(4) + poseidon2(3) + 3 * bits(64) + 2 * cmp(64),
  transfer: D * (poseidon2(3) + 3) + 3 * poseidon2(4) + poseidon2(3) + 4 * bits(64) + 2 * cmp(64),
  // Poseidon(5) leaf has tag+4 fields -> no t=5 Poseidon2 instance; t=8 is the next one (R_P=57, paper value)
  compliance: D * (poseidon2(3) + 3) + poseidon2(8, 57) + 2 * poseidon2(3)
    + cmp(64) + cmp(8) + 2 + 1 + 3 * bits(64) + 2 * bits(8),
};
for (const k of Object.keys(p2))
  console.log(k.padEnd(11), model[k], "->", p2[k], `(${(100 * (p2[k] - model[k]) / model[k]).toFixed(1)}%)`);

console.log("\n== UNMEASURED prediction B: 4-ary Merkle tree, depth 10 (same 2^20 leaves) ==");
for (const mux of [8, 14, 20]) { // per-level select cost is the uncertain term: sweep it
  const lvl = poseidon(4) + mux;
  const tr = model.transfer - D * merkleLevel + 10 * lvl;
  const co = model.compliance - D * merkleLevel + 10 * lvl;
  console.log(`select cost ${String(mux).padStart(2)}/level: level=${lvl}  path=${10 * lvl}  transfer ${model.transfer}->${tr} (${(100 * (tr - model.transfer) / model.transfer).toFixed(1)}%)  compliance ${model.compliance}->${co} (${(100 * (co - model.compliance) / model.compliance).toFixed(1)}%)`);
}
