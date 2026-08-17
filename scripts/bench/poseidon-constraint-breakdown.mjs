#!/usr/bin/env node
/**
 * poseidon-constraint-breakdown.mjs — decomposes transfer.circom's / compliance.circom's
 * R1CS constraint count into its per-gadget contributions.
 *
 * BASELINE.md reports whole-circuit totals only (e.g. transfer.circom: 13,611 constraints,
 * 6,470 non-linear). This script isolates each gadget transfer.circom actually instantiates
 * — Poseidon(2)/(3)/(4), the 20-level MerkleProof (Poseidon(2) x20 + MultiMux1(2) x20), and
 * the non-Poseidon range-check scaffolding (GreaterThan(64), Num2Bits(64) x4, LessEqThan(64))
 * — by compiling each alone with the exact same circom invocation compile.sh uses, then sums
 * the isolated numbers and diffs them against the real whole-circuit totals to show what the
 * optimizer does/doesn't collapse across instances.
 *
 * Usage:
 *   node scripts/bench/poseidon-constraint-breakdown.mjs
 *
 * Prerequisite: circom on PATH (same version BASELINE.md was measured with), circuits/node_modules
 * installed (npm install in circuits/).
 */
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const NODE_MODULES = join(CIRCUITS_DIR, "node_modules");
const SNARKJS = join(NODE_MODULES, ".bin", "snarkjs");
const TEMPLATES_DIR = join(CIRCUITS_DIR, "templates");

const CASES = [
  {
    name: "poseidon2",
    label: "Poseidon(2) — single call",
    src: `pragma circom 2.1.0;
include "circomlib/circuits/poseidon.circom";
template Wrap2() {
    signal input in[2];
    signal output out;
    component h = Poseidon(2);
    h.inputs[0] <== in[0];
    h.inputs[1] <== in[1];
    out <== h.out;
}
component main {public [in]} = Wrap2();
`,
  },
  {
    name: "poseidon3",
    label: "Poseidon(3) — single call",
    src: `pragma circom 2.1.0;
include "circomlib/circuits/poseidon.circom";
template Wrap3() {
    signal input in[3];
    signal output out;
    component h = Poseidon(3);
    h.inputs[0] <== in[0];
    h.inputs[1] <== in[1];
    h.inputs[2] <== in[2];
    out <== h.out;
}
component main {public [in]} = Wrap3();
`,
  },
  {
    name: "poseidon4",
    label: "Poseidon(4) — single call",
    src: `pragma circom 2.1.0;
include "circomlib/circuits/poseidon.circom";
template Wrap4() {
    signal input in[4];
    signal output out;
    component h = Poseidon(4);
    h.inputs[0] <== in[0];
    h.inputs[1] <== in[1];
    h.inputs[2] <== in[2];
    h.inputs[3] <== in[3];
    out <== h.out;
}
component main {public [in]} = Wrap4();
`,
  },
  {
    name: "merkle20",
    label: "MerkleProof(20) — full Merkle-path gadget (mux + 20x Poseidon(2))",
    src: `pragma circom 2.1.0;
include "merkle_proof.circom";
component main {public [leaf, pathElements, pathIndices]} = MerkleProof(20);
`,
    extraInclude: TEMPLATES_DIR,
  },
  {
    name: "scaffolding",
    label: "Non-Poseidon range-check scaffolding (GreaterThan(64) + 4x Num2Bits(64) + LessEqThan(64) + addition)",
    src: `pragma circom 2.1.0;
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
template Scaffolding() {
    signal input cumulativeOld;
    signal input txAmount;
    signal input threshold;
    signal cumulativeNew;
    cumulativeNew <== cumulativeOld + txAmount;

    component gtZero = GreaterThan(64);
    gtZero.in[0] <== txAmount;
    gtZero.in[1] <== 0;
    gtZero.out === 1;

    component oldBits = Num2Bits(64);
    oldBits.in <== cumulativeOld;
    component txBits = Num2Bits(64);
    txBits.in <== txAmount;
    component newBits = Num2Bits(64);
    newBits.in <== cumulativeNew;
    component threshBits = Num2Bits(64);
    threshBits.in <== threshold;

    component ltThreshold = LessEqThan(64);
    ltThreshold.in[0] <== cumulativeNew;
    ltThreshold.in[1] <== threshold;
    ltThreshold.out === 1;
}
component main {public [cumulativeOld, txAmount, threshold]} = Scaffolding();
`,
  },
];

function parseR1csInfo(output) {
  const grab = (label) => {
    const m = output.match(new RegExp(`# of ${label}:\\s*([0-9]+)`));
    return m ? parseInt(m[1], 10) : null;
  };
  return {
    wires: grab("Wires"),
    constraints: grab("Constraints"),
    privateInputs: grab("Private Inputs"),
    publicInputs: grab("Public Inputs"),
    publicOutputs: grab("Public Outputs"),
    labels: grab("Labels"),
    // snarkjs r1cs info doesn't split linear/non-linear directly in newer output;
    // circom's own compiler stderr during --r1cs does. We parse both sources.
  };
}

function run() {
  const workDir = mkdtempSync(join(tmpdir(), "veil-poseidon-bench-"));
  const results = [];

  console.log("=== Veil Poseidon constraint-contribution breakdown ===");
  console.log(`circom: ${execFileSync("circom", ["--version"]).toString().trim()}`);
  console.log(`workdir: ${workDir}\n`);

  for (const c of CASES) {
    const srcPath = join(workDir, `${c.name}.circom`);
    writeFileSync(srcPath, c.src);

    const includeArgs = ["-l", NODE_MODULES];
    if (c.extraInclude) includeArgs.push("-l", c.extraInclude);

    const cmd = ["circom", srcPath, "--r1cs", "--output", workDir, ...includeArgs];
    console.log(`$ ${cmd.join(" ")}`);
    let compileOut;
    try {
      compileOut = execFileSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
    } catch (e) {
      console.error(`[FAIL] ${c.name}: ${e.stdout || e.message}`);
      results.push({ ...c, error: true });
      continue;
    }
    console.log(compileOut.trim());

    const r1csPath = join(workDir, `${c.name}.r1cs`);
    const infoCmd = [SNARKJS, "r1cs", "info", r1csPath];
    console.log(`$ ${infoCmd.join(" ")}`);
    const infoOut = execFileSync(infoCmd[0], infoCmd.slice(1), { encoding: "utf8" });
    console.log(infoOut.trim(), "\n");

    const parsed = parseR1csInfo(infoOut);
    results.push({ ...c, ...parsed });
  }

  console.log("\n=== Summary ===");
  console.log("| Gadget | R1CS constraints |");
  console.log("|---|---|");
  for (const r of results) {
    if (r.error) {
      console.log(`| ${r.label} | FAILED |`);
    } else {
      console.log(`| ${r.label} | ${r.constraints} |`);
    }
  }

  const byName = Object.fromEntries(results.map((r) => [r.name, r]));
  if (byName.merkle20 && byName.poseidon2 && !byName.merkle20.error && !byName.poseidon2.error) {
    const muxOverhead = byName.merkle20.constraints - 20 * byName.poseidon2.constraints;
    console.log(
      `\nMerkleProof(20) = 20 x Poseidon(2) (${20 * byName.poseidon2.constraints}) + MultiMux1(2) x20 overhead (${muxOverhead})`
    );
  }

  if (
    byName.merkle20 &&
    byName.poseidon4 &&
    byName.poseidon3 &&
    byName.scaffolding &&
    !byName.merkle20.error &&
    !byName.poseidon4.error &&
    !byName.poseidon3.error &&
    !byName.scaffolding.error
  ) {
    const predictedTransfer =
      byName.merkle20.constraints + 3 * byName.poseidon4.constraints + byName.poseidon3.constraints + byName.scaffolding.constraints;
    console.log(`\nPredicted transfer.circom total (sum of isolated gadgets, no cross-instance dedup) = ${predictedTransfer}`);
    console.log("Real transfer.circom total (BASELINE.md, 2026-07-22) = 13611");
    console.log(`Delta = ${predictedTransfer - 13611} (${(((predictedTransfer - 13611) / 13611) * 100).toFixed(1)}%)`);
  }

  rmSync(workDir, { recursive: true, force: true });
}

run();
