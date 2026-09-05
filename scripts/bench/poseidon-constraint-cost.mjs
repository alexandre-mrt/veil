#!/usr/bin/env node
/**
 * poseidon-constraint-cost.mjs — isolates the R1CS constraint cost of every Poseidon call
 * (by arity) and every range-check component Veil's three circuits use, then reconciles the
 * sum against the whole-circuit totals already recorded in docs/research/BASELINE.md.
 *
 * This answers, with real numbers instead of a guess: "of transfer.circom's 6,470 non-linear
 * constraints, how many are Poseidon, how many are Num2Bits/GreaterThan range checks, and how
 * much is left over?" — the open question BASELINE.md's own report flagged as the natural next
 * step for a Poseidon2 experiment (2026-07-22 report, "Open questions" #4).
 *
 * Each fixture under fixtures/poseidon-cost/ instantiates exactly one component as `main`, so its
 * measured constraint count is that component's cost in isolation, uncontaminated by anything
 * else in a production circuit.
 *
 * Usage:
 *   node scripts/bench/poseidon-constraint-cost.mjs
 *
 * Toolchain: tries `circom` on PATH first (native binary, e.g. built from iden3/circom); falls
 * back to circom2 (github.com/iden3/circomlib's npm-distributed WASM build of the same compiler,
 * `circuits/node_modules/.bin/circom2` if `npm install` has been run in circuits/) when no native
 * binary is present — which is the common case in a sandboxed environment with no access to
 * GitHub releases or a from-source Rust build. Verified byte-for-byte identical constraint counts
 * against the existing BASELINE.md numbers before being trusted for this experiment (circom2
 * 0.2.23 reports "circom compiler 2.2.3", one patch above the 2.2.2 used for the original
 * baseline).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CIRCUITS_DIR = join(REPO_ROOT, "circuits");
const FIXTURES_DIR = join(__dirname, "fixtures", "poseidon-cost");

function findCircom() {
  try {
    execFileSync("circom", ["--version"], { stdio: "pipe" });
    return { cmd: "circom", args: [] };
  } catch {
    // fall through to circom2
  }
  const circom2Bin = join(CIRCUITS_DIR, "node_modules", ".bin", "circom2");
  if (existsSync(circom2Bin)) {
    return { cmd: circom2Bin, args: [] };
  }
  throw new Error(
    "No circom compiler found. Install one of:\n" +
      "  - native: cargo install --git https://github.com/iden3/circom.git (needs GitHub access)\n" +
      "  - WASM fallback (no GitHub/cargo build needed): cd circuits && npm install circom2",
  );
}

function compileAndCount(circom, fixtureName, outDir, extraLibs = []) {
  const src = join(FIXTURES_DIR, `${fixtureName}.circom`);
  const libs = [CIRCUITS_DIR, join(CIRCUITS_DIR, "node_modules"), ...extraLibs];
  const args = [
    ...circom.args,
    src,
    "--r1cs",
    "--sym",
    "--output",
    outDir,
    ...libs.flatMap((l) => ["-l", l]),
  ];
  const out = execFileSync(circom.cmd, args, { encoding: "utf8" });
  const nonLinear = Number(out.match(/non-linear constraints:\s*(\d+)/)?.[1]);
  // Not just /linear constraints:/ — that also matches inside "non-linear constraints:".
  const linear = Number(out.match(/^linear constraints:\s*(\d+)/m)?.[1]);
  if (!Number.isFinite(nonLinear) || !Number.isFinite(linear)) {
    throw new Error(`Could not parse constraint counts for ${fixtureName}:\n${out}`);
  }
  return { nonLinear, linear };
}

// Call counts per production circuit, from a direct grep of transfer.circom / compliance.circom /
// withdraw.circom / templates/merkle_proof.circom (see the experiment report for exact line
// numbers). Update this table if a circuit's hash/range-check call sites change.
const CIRCUITS = {
  "transfer.circom": {
    baselineNonLinear: 6470,
    baselineLinear: 7141,
    components: { arity4: 3, arity3: 1, merkle20: 1, num2bits64: 4, greaterthan64: 1 },
  },
  "compliance.circom": {
    baselineNonLinear: 6057,
    baselineLinear: 6686,
    components: { arity5: 1, arity3: 2, merkle20: 1, num2bits64: 3 },
  },
  "withdraw.circom": {
    baselineNonLinear: 1465,
    baselineLinear: 1593,
    components: { arity4: 3, arity2: 1, num2bits64: 3, greaterthan64: 1 },
  },
};

function main() {
  const circom = findCircom();
  console.log(`Using circom: ${circom.cmd} ${circom.args.join(" ")}`.trim());
  try {
    execFileSync(circom.cmd, ["--version"], { stdio: "pipe" })
      .toString()
      .split("\n")
      .forEach((l) => l.trim() && console.log(`  ${l.trim()}`));
  } catch {}

  const tmp = mkdtempSync(join(tmpdir(), "veil-poseidon-cost-"));
  const fixtures = [
    "arity2",
    "arity3",
    "arity4",
    "arity5",
    "num2bits64",
    "greaterthan64",
    "merkle20",
  ];
  const cost = {};
  console.log("\n=== Isolated component cost (real circom compile, one component per circuit) ===");
  console.log("component        | non-linear | linear");
  console.log("-----------------|------------|-------");
  for (const f of fixtures) {
    cost[f] = compileAndCount(circom, f, tmp);
    console.log(`${f.padEnd(17)}| ${String(cost[f].nonLinear).padStart(10)} | ${cost[f].linear}`);
  }

  console.log("\n=== Reconciliation against docs/research/BASELINE.md ===");
  for (const [name, spec] of Object.entries(CIRCUITS)) {
    let nonLinear = 0;
    let linear = 0;
    const parts = [];
    for (const [comp, count] of Object.entries(spec.components)) {
      nonLinear += cost[comp].nonLinear * count;
      linear += cost[comp].linear * count;
      parts.push(`${count}x${comp}`);
    }
    const residualNonLinear = spec.baselineNonLinear - nonLinear;
    const pct = ((nonLinear / spec.baselineNonLinear) * 100).toFixed(1);
    console.log(`\n${name}  (${parts.join(" + ")})`);
    console.log(
      `  hash+range-check non-linear: ${nonLinear} / ${spec.baselineNonLinear} baseline (${pct}%)`,
    );
    console.log(`  unattributed residual (other comparators/logic): ${residualNonLinear}`);
    console.log(`  linear: ${linear} attributed vs ${spec.baselineLinear} baseline`);
  }

  rmSync(tmp, { recursive: true, force: true });
}

main();
