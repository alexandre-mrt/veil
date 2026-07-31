#!/usr/bin/env node
/**
 * hash-constraint-attribution.mjs — attributes each production circuit's R1CS constraint
 * budget to its hashing (Poseidon identity/nullifier hashes + the depth-20 Merkle path) vs
 * everything else (range checks, comparators, threshold/epoch logic).
 *
 * Method: compile isolated single-primitive circuits (bare Poseidon(t) for each arity actually
 * used, and the real MerkleProof(depth) template at depth 20) to get each primitive's exact
 * constraint cost, then compile the three production circuits fresh and compare the attributed
 * sum (instance count x primitive cost, per PRODUCTION_USAGE below) against the real measured
 * total. PRODUCTION_USAGE is derived by hand from `grep -n "Poseidon(" circuits/*.circom` and
 * each circuit's `component main = X(depth)` line — re-check it if a circuit's hash calls change.
 *
 * Usage:
 *   node scripts/bench/hash-constraint-attribution.mjs [--circom /path/to/circom]
 *
 * Prerequisite: a `circom` 2.2.x binary on PATH, or pass one via --circom. `circuits/`
 * must have `npm install` run (needs circomlib in node_modules).
 */
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CIRCUITS_DIR = join(REPO_ROOT, "circuits");
const CIRCOMLIB = join(CIRCUITS_DIR, "node_modules", "circomlib", "circuits");
const MERKLE_TEMPLATE = join(CIRCUITS_DIR, "templates", "merkle_proof.circom");

const CIRCOM = (() => {
  const idx = process.argv.indexOf("--circom");
  return idx !== -1 ? process.argv[idx + 1] : "circom";
})();

// Hand-derived from `grep -n "Poseidon(" circuits/*.circom` and each circuit's
// `component main = X(...)` line (see docs/research/2026-07-31-hash-constraint-attribution.md).
const PRODUCTION_USAGE = {
  transfer: { poseidon: [4, 4, 4, 3], merkleDepth: 20 },
  compliance: { poseidon: [5, 3, 3], merkleDepth: 20 },
  withdraw: { poseidon: [4, 4, 4, 2], merkleDepth: null },
};

function compileAndParse(circomSource, label) {
  const dir = mkdtempSync(join(tmpdir(), "veil-bench-"));
  const file = join(dir, "main.circom");
  writeFileSync(file, circomSource);
  let out;
  try {
    out = execFileSync(CIRCOM, [file, "--r1cs", "-l", CIRCOMLIB, "-o", dir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // circom writes its report to stdout even on some warning paths; execFileSync throws only
    // on non-zero exit, at which point err.stdout/err.stderr carry the same text.
    out = (err.stdout || "") + (err.stderr || "");
    if (!/non-linear constraints/.test(out)) {
      console.error(`[FAIL] ${label}:\n${out}`);
      throw err;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const nonLinear = parseInt(/non-linear constraints:\s*(\d+)/.exec(out)[1], 10);
  // Anchored to start-of-line: "non-linear constraints:" also matches a naive
  // /linear constraints:/ regex as a substring, which silently duplicates the non-linear count.
  const linear = parseInt(/^linear constraints:\s*(\d+)/m.exec(out)[1], 10);
  return { label, nonLinear, linear, raw: out };
}

function poseidonCircuit(arity) {
  return `pragma circom 2.0.0;\ninclude "poseidon.circom";\ncomponent main = Poseidon(${arity});\n`;
}

function merkleCircuit(depth) {
  return `pragma circom 2.1.0;\ninclude "${MERKLE_TEMPLATE}";\ncomponent main = MerkleProof(${depth});\n`;
}

function productionCircuit(name) {
  const fileMap = { transfer: "transfer.circom", compliance: "compliance.circom", withdraw: "withdraw.circom" };
  return { path: join(CIRCUITS_DIR, fileMap[name]) };
}

function compileProductionFile(path) {
  const out = execFileSync(CIRCOM, [path, "--r1cs", "-l", join(CIRCUITS_DIR, "node_modules"), "-o", mkdtempSync(join(tmpdir(), "veil-bench-prod-"))], {
    encoding: "utf8",
    cwd: CIRCUITS_DIR,
  });
  const nonLinear = parseInt(/non-linear constraints:\s*(\d+)/.exec(out)[1], 10);
  const linear = parseInt(/^linear constraints:\s*(\d+)/m.exec(out)[1], 10);
  return { nonLinear, linear, raw: out };
}

function main() {
  console.log("=== Veil hash-constraint attribution ===");
  console.log(`circom: ${execFileSync(CIRCOM, ["--version"]).toString().trim()}\n`);

  const arities = [...new Set(Object.values(PRODUCTION_USAGE).flatMap((u) => u.poseidon))].sort((a, b) => a - b);
  const poseidonCost = {};
  for (const a of arities) {
    const r = compileAndParse(poseidonCircuit(a), `Poseidon(${a})`);
    poseidonCost[a] = r;
    console.log(`Poseidon(${a}): non-linear=${r.nonLinear} linear=${r.linear}`);
  }

  const merkleCost = compileAndParse(merkleCircuit(20), "MerkleProof(20)");
  console.log(`MerkleProof(20): non-linear=${merkleCost.nonLinear} linear=${merkleCost.linear}\n`);

  const results = [];
  for (const [name, usage] of Object.entries(PRODUCTION_USAGE)) {
    const { path } = productionCircuit(name);
    const actual = compileProductionFile(path);

    const poseidonNonLinear = usage.poseidon.reduce((s, a) => s + poseidonCost[a].nonLinear, 0);
    const poseidonLinear = usage.poseidon.reduce((s, a) => s + poseidonCost[a].linear, 0);
    const merkleNonLinear = usage.merkleDepth ? merkleCost.nonLinear : 0;
    const merkleLinear = usage.merkleDepth ? merkleCost.linear : 0;

    const attributedNonLinear = poseidonNonLinear + merkleNonLinear;
    const attributedLinear = poseidonLinear + merkleLinear;

    const row = {
      circuit: name,
      poseidonInstances: usage.poseidon,
      merkleDepth: usage.merkleDepth,
      actualNonLinear: actual.nonLinear,
      actualLinear: actual.linear,
      attributedNonLinear,
      attributedLinear,
      hashPctNonLinear: ((attributedNonLinear / actual.nonLinear) * 100).toFixed(1),
      hashPctLinear: ((attributedLinear / actual.linear) * 100).toFixed(1),
      residualNonLinear: actual.nonLinear - attributedNonLinear,
      residualLinear: actual.linear - attributedLinear,
    };
    results.push(row);

    console.log(`--- ${name} ---`);
    console.log(`  actual:     non-linear=${actual.nonLinear} linear=${actual.linear}`);
    console.log(`  attributed: non-linear=${attributedNonLinear} (${row.hashPctNonLinear}%)  linear=${attributedLinear} (${row.hashPctLinear}%)`);
    console.log(`  residual (non-hash logic): non-linear=${row.residualNonLinear} linear=${row.residualLinear}`);
    console.log("");
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify({ poseidonCost, merkleCost: { nonLinear: merkleCost.nonLinear, linear: merkleCost.linear }, results }, null, 2));
}

main();
