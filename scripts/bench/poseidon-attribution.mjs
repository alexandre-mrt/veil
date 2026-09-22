#!/usr/bin/env node
/**
 * poseidon-attribution.mjs — Reconstructs each production circuit's whole-circuit R1CS
 * constraint count as a sum of named, independently-measured gadget costs, so "Poseidon
 * dominates the constraint count" becomes a number instead of an impression.
 *
 * Two measurements, both real commands, no estimates:
 *   1. circuits/bench-primitives/*.circom compiled in isolation (one gadget each) —
 *      run `bash circuits/scripts/bench-primitives.sh` first, this script reads its
 *      circuits/build-bench-primitives/results.tsv.
 *   2. transfer.circom / compliance.circom / withdraw.circom compiled fresh by this
 *      script (circom --r1cs only, no ptau/zkey needed for a constraint count).
 *
 * The two are reconciled: sum(named gadget costs) vs. the whole-circuit total. A
 * non-zero residual is reported explicitly rather than hidden — it is the cost of
 * top-level assertions (`===`, `+`, `-`) that aren't inside any gadget.
 *
 * Usage: node scripts/bench/poseidon-attribution.mjs
 * Prerequisite: circom on PATH; bash circuits/scripts/bench-primitives.sh already run once.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const PRIM_RESULTS = join(CIRCUITS_DIR, "build-bench-primitives", "results.tsv");
const SCRATCH_DIR = join(CIRCUITS_DIR, "build-bench-primitives", "full");

function readPrimitives() {
  if (!existsSync(PRIM_RESULTS)) {
    console.error(
      `Missing ${PRIM_RESULTS} — run: bash circuits/scripts/bench-primitives.sh`
    );
    process.exit(1);
  }
  const rows = readFileSync(PRIM_RESULTS, "utf8").trim().split("\n").slice(1);
  const out = {};
  for (const row of rows) {
    const [gadget, total, nonlin, lin, wires] = row.split("\t");
    out[gadget] = { total: +total, nonlin: +nonlin, lin: +lin, wires: +wires };
  }
  return out;
}

function compileMain(circuitFile) {
  mkdirSync(SCRATCH_DIR, { recursive: true });
  const stdout = execFileSync(
    "circom",
    [circuitFile, "--r1cs", "-o", SCRATCH_DIR],
    { cwd: CIRCUITS_DIR, encoding: "utf8" }
  );
  const grab = (label) => {
    const m = stdout.match(new RegExp(`^${label}: (\\d+)$`, "m"));
    return m ? +m[1] : NaN;
  };
  return { nonlin: grab("non-linear constraints"), lin: grab("linear constraints") };
}

const P = readPrimitives();

// Named breakdown: each entry is [label, nonlin, lin], derived from the primitive
// measurements above multiplied by how many times the production circuit instantiates it.
// See docs/research/2026-09-22-poseidon-constraint-attribution.md for the circuit-by-circuit
// derivation this mirrors line for line.
const BREAKDOWNS = {
  "transfer.circom": [
    ["Merkle path (depth 20): 20x Poseidon(2)", 20 * P.poseidon2.nonlin, 20 * P.poseidon2.lin],
    ["Merkle path (depth 20): 20x MultiMux1(2) + binary check", 20 * (P.multimux1x2.nonlin + 1), 20 * P.multimux1x2.lin],
    ["oldCommitment, newCommitment, nullifier: 3x Poseidon(4)", 3 * P.poseidon4.nonlin, 3 * P.poseidon4.lin],
    ["txAmountHash: 1x Poseidon(3)", P.poseidon3.nonlin, P.poseidon3.lin],
    ["Range checks: 4x Num2Bits(64)", 4 * P.num2bits64.nonlin, 4 * P.num2bits64.lin],
    ["Comparators: GreaterThan(64) + LessEqThan(64)", P.greaterthan64.nonlin + P.lessequalthan64.nonlin, P.greaterthan64.lin + P.lessequalthan64.lin],
  ],
  "compliance.circom": [
    ["Credential leaf: 1x Poseidon(5)", P.poseidon5.nonlin, P.poseidon5.lin],
    ["Merkle path (depth 20): 20x Poseidon(2)", 20 * P.poseidon2.nonlin, 20 * P.poseidon2.lin],
    ["Merkle path (depth 20): 20x MultiMux1(2) + binary check", 20 * (P.multimux1x2.nonlin + 1), 20 * P.multimux1x2.lin],
    ["Nullifier + context binding: 2x Poseidon(3)", 2 * P.poseidon3.nonlin, 2 * P.poseidon3.lin],
    ["Expiry/KYC comparators: GreaterEqThan(64) + GreaterEqThan(8)", P.greaterequalthan64.nonlin + P.greaterequalthan8.nonlin, P.greaterequalthan64.lin + P.greaterequalthan8.lin],
    ["Defense-in-depth binary checks + AND gate (3x quadratic)", 3, 0],
    ["Range checks: 2x Num2Bits(64) + 2x Num2Bits(8) + 1x Num2Bits(64)", 3 * P.num2bits64.nonlin + 2 * P.num2bits8.nonlin, 3 * P.num2bits64.lin + 2 * P.num2bits8.lin],
  ],
  "withdraw.circom": [
    ["commitment + change commitment + nullifier: 3x Poseidon(4)", 3 * P.poseidon4.nonlin, 3 * P.poseidon4.lin],
    ["recipientHash: 1x Poseidon(2)", P.poseidon2.nonlin, P.poseidon2.lin],
    ["Range checks: 3x Num2Bits(64)", 3 * P.num2bits64.nonlin, 3 * P.num2bits64.lin],
    ["Comparators: GreaterThan(64) + LessEqThan(64)", P.greaterthan64.nonlin + P.lessequalthan64.nonlin, P.greaterthan64.lin + P.lessequalthan64.lin],
  ],
};

const FILES = { "transfer.circom": "transfer.circom", "compliance.circom": "compliance.circom", "withdraw.circom": "withdraw.circom" };

let anyMismatch = false;

for (const [name, file] of Object.entries(FILES)) {
  const actual = compileMain(file);
  const parts = BREAKDOWNS[name];
  const sumNonlin = parts.reduce((a, [, n]) => a + n, 0);
  const sumLin = parts.reduce((a, [, , l]) => a + l, 0);

  console.log(`\n=== ${name} ===`);
  console.log(`  whole-circuit (circom --r1cs, this run): non-linear ${actual.nonlin}, linear ${actual.lin}`);
  for (const [label, n, l] of parts) {
    console.log(`  ${label.padEnd(60)} non-linear ${String(n).padStart(6)}  linear ${String(l).padStart(6)}`);
  }
  const poseidonNonlin = parts
    .filter(([l]) => l.toLowerCase().includes("poseidon"))
    .reduce((a, [, n]) => a + n, 0);
  console.log(`  sum of named parts:                                          non-linear ${sumNonlin}  linear ${sumLin}`);
  console.log(`  residual (top-level assertions not in any gadget):          non-linear ${actual.nonlin - sumNonlin}  linear ${actual.lin - sumLin}`);
  console.log(`  Poseidon share of non-linear constraints: ${poseidonNonlin}/${actual.nonlin} = ${((100 * poseidonNonlin) / actual.nonlin).toFixed(1)}%`);

  const nonlinResidual = actual.nonlin - sumNonlin;
  const linResidual = actual.lin - sumLin;
  if (Math.abs(nonlinResidual) > 0 || Math.abs(linResidual) > 2) {
    anyMismatch = true;
    console.error(`  WARNING: residual larger than expected for ${name} — breakdown may be stale.`);
  }
}

if (anyMismatch) {
  console.error("\nOne or more circuits had an unexpectedly large residual — see warnings above.");
  process.exit(1);
}
console.log("\nAll three circuits reconciled within tolerance (non-linear exact, linear residual <= 2).");
