#!/usr/bin/env node
/**
 * poseidon-isolation.mjs — isolates how many of each real circuit's R1CS constraints
 * come from Poseidon (the depth-20 Merkle path hasher and the top-level identity/
 * nullifier hashes) versus everything else (range checks, comparators, epoch logic).
 *
 * Compiles standalone one-component circuits (Poseidon(2..5), MerkleProof(20)) with
 * circom2 (WASM circom 2.2.3, npm — avoids the cargo/GitHub release download path,
 * which this sandbox's egress policy blocks), reads their real r1cs constraint counts,
 * then multiplies by how many times each is instantiated in transfer/withdraw/compliance
 * and diffs the predicted sum against each circuit's actual (also freshly compiled)
 * non-linear constraint count.
 *
 * Usage:
 *   node scripts/bench/poseidon-isolation.mjs
 *
 * Prerequisite: `npm install` in this directory (installs circom2 + circomlib).
 */
import { execFileSync } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CIRCOM2_CLI = join(__dirname, "node_modules", "circom2", "cli.js");

function compile(relCircomPath, label) {
  const outDir = mkdtempSync(join(tmpdir(), "poseidon-iso-"));
  const cmd = `node ${CIRCOM2_CLI} ${relCircomPath} --r1cs --output ${outDir} -l .`;
  let stdout;
  try {
    stdout = execFileSync(
      "node",
      [CIRCOM2_CLI, relCircomPath, "--r1cs", "--output", outDir, "-l", "."],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
  } catch (err) {
    console.error(`FAILED compiling ${label}: ${relCircomPath}`);
    console.error(err.stdout ?? err.message);
    process.exit(1);
  }
  const nonLinear = parseInt(stdout.match(/non-linear constraints:\s*(\d+)/)?.[1] ?? "-1", 10);
  const linear = parseInt(stdout.match(/linear constraints:\s*(\d+)/)?.[1] ?? "-1", 10);
  const wires = parseInt(stdout.match(/wires:\s*(\d+)/)?.[1] ?? "-1", 10);
  console.log(`--- ${label} (${cmd}) ---`);
  console.log(stdout.trim());
  console.log();
  return { label, nonLinear, linear, wires };
}

console.log("=== Poseidon isolation benchmark (circom2 0.2.23 / circom 2.2.3, WASM) ===\n");

// Isolated single-component circuits.
const iso = {};
for (const n of [2, 3, 4, 5]) {
  iso[n] = compile(`scripts/bench/poseidon-isolation/circuits/poseidon_${n}.circom`, `Poseidon(${n})`);
}
iso.merkle20 = compile("scripts/bench/poseidon-isolation/circuits/merkle_20.circom", "MerkleProof(20)");

// Real circuits, compiled fresh (not read from a stale build/ dir).
const real = {
  transfer: compile("circuits/transfer.circom", "transfer.circom (actual)"),
  withdraw: compile("circuits/withdraw.circom", "withdraw.circom (actual)"),
  compliance: compile("circuits/compliance.circom", "compliance.circom (actual)"),
};

// Instance counts per circuit, read directly from each .circom source
// (see the `component X = Poseidon(N)` / `MerkleProof(20)` lines).
const composition = {
  transfer: { merkle20: 1, 4: 3, 3: 1 },
  withdraw: { 4: 3, 2: 1 },
  compliance: { merkle20: 1, 5: 1, 3: 2 },
};

console.log("=== Predicted vs actual non-linear constraints ===\n");
const rows = [];
for (const [circuit, comp] of Object.entries(composition)) {
  let predicted = 0;
  const parts = [];
  for (const [key, count] of Object.entries(comp)) {
    const unit = key === "merkle20" ? iso.merkle20 : iso[key];
    predicted += unit.nonLinear * count;
    parts.push(`${count}x ${key === "merkle20" ? "MerkleProof(20)" : `Poseidon(${key})`} (${unit.nonLinear} each)`);
  }
  const actual = real[circuit].nonLinear;
  const glue = actual - predicted;
  rows.push({ circuit, parts: parts.join(" + "), predicted, actual, glue, gluePct: ((glue / actual) * 100).toFixed(1), poseidonPct: ((predicted / actual) * 100).toFixed(1) });
}

for (const r of rows) {
  console.log(`${r.circuit}:`);
  console.log(`  composition: ${r.parts}`);
  console.log(`  predicted Poseidon-only sum: ${r.predicted}`);
  console.log(`  actual total non-linear:     ${r.actual}`);
  console.log(`  non-Poseidon glue:           ${r.glue} (${r.gluePct}%)`);
  console.log(`  Poseidon share:               ${r.poseidonPct}%`);
  console.log();
}

console.log("Per-Merkle-level cost (one MerkleProof(20) step):");
console.log(`  ${iso.merkle20.nonLinear} / 20 = ${(iso.merkle20.nonLinear / 20).toFixed(1)} non-linear constraints/level`);
console.log(`  (Poseidon(2) alone: ${iso[2].nonLinear}; MultiMux1(2) selector overhead: ${(iso.merkle20.nonLinear / 20 - iso[2].nonLinear).toFixed(2)}/level)`);
