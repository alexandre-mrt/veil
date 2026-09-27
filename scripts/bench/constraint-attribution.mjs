#!/usr/bin/env node
/**
 * constraint-attribution.mjs — attributes Veil's circuit non-linear constraint
 * counts to their individual gadget instances (Poseidon arity, MerkleProof(20),
 * Num2Bits, comparators), and cross-checks the attribution against a fresh
 * compile of the three real circuits.
 *
 * Uses circom2 (github.com/antimatter15/circom2 on npm), a WASM build of the
 * real Rust circom 2.x compiler bundled inside the npm tarball itself — no
 * GitHub release download or `cargo build` required. This sandbox's egress
 * policy denies both github.com (release binaries) and any Sui RPC host, but
 * registry.npmjs.org is on the allowlist, so this is the only circom compiler
 * reachable here tonight. See docs/research/2026-09-27-poseidon-constraint-attribution.md
 * for the toolchain note.
 *
 * Usage:
 *   node scripts/bench/constraint-attribution.mjs
 */
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = __dirname;
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const CIRCOM2_CLI = join(__dirname, "node_modules", "circom2", "cli.js");

function compile(circomFile, { cwd = BENCH_DIR, libs = [join(BENCH_DIR, "node_modules")] } = {}) {
  const outDir = mkdtempSync(join(tmpdir(), "veil-probe-"));
  const args = [circomFile, "--r1cs", "--verbose", "-o", outDir];
  for (const lib of libs) args.push("-l", lib);
  let stdout;
  try {
    stdout = execFileSync("node", [CIRCOM2_CLI, ...args], { cwd, encoding: "utf8" });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  return parseVerbose(stdout);
}

function parseVerbose(stdout) {
  // Line-anchored: "linear constraints:" is a suffix of "non-linear constraints:",
  // so a plain substring/regex search for "linear constraints" would match the
  // non-linear line first and silently report the wrong number for both.
  const grab = (label) => {
    const m = stdout.match(new RegExp(`^${label}:\\s*(\\d+)$`, "m"));
    return m ? parseInt(m[1], 10) : null;
  };
  return {
    nonLinear: grab("non-linear constraints"),
    linear: grab("linear constraints"),
    wires: grab("wires"),
    raw: stdout,
  };
}

// circom2's WASI filesystem shim cannot resolve `../`-traversing includes
// (confirmed: a bare-name include inside a same-directory file works, a
// multi-level "../../circuits/..." include or -l path does not, regardless
// of whether the target is a preopened ancestor). MerkleProof(20) lives in
// ../../circuits/templates/merkle_proof.circom relative to circuit-probes/,
// so rather than hand-copy it (a copy that would silently drift from the
// real template), materialize a same-directory copy from the actual source
// file via plain Node fs (not the WASM/WASI sandbox) on every run, with its
// two includes rewritten to the same bare-name form the other probes use.
function materializeMerkleProbe() {
  const src = readFileSync(join(CIRCUITS_DIR, "templates", "merkle_proof.circom"), "utf8");
  const rewritten = src
    .replace('include "../node_modules/circomlib/circuits/poseidon.circom";', 'include "circomlib/circuits/poseidon.circom";')
    .replace('include "../node_modules/circomlib/circuits/mux1.circom";', 'include "circomlib/circuits/mux1.circom";');
  const dest = join(BENCH_DIR, "circuit-probes", "_merkle_proof.generated.circom");
  writeFileSync(dest, rewritten);
  writeFileSync(
    join(BENCH_DIR, "circuit-probes", "_merkle20_probe.generated.circom"),
    [
      "pragma circom 2.1.0;",
      'include "_merkle_proof.generated.circom";',
      "template Probe() {",
      "    signal input leaf;",
      "    signal input pathElements[20];",
      "    signal input pathIndices[20];",
      "    signal output root;",
      "    component m = MerkleProof(20);",
      "    m.leaf <== leaf;",
      "    for (var i = 0; i < 20; i++) {",
      "        m.pathElements[i] <== pathElements[i];",
      "        m.pathIndices[i] <== pathIndices[i];",
      "    }",
      "    root <== m.root;",
      "}",
      "component main = Probe();",
      "",
    ].join("\n")
  );
  return "circuit-probes/_merkle20_probe.generated.circom";
}

const PROBES = [
  { name: "Poseidon(2)", file: "circuit-probes/poseidon2.circom" },
  { name: "Poseidon(3)", file: "circuit-probes/poseidon3.circom" },
  { name: "Poseidon(4)", file: "circuit-probes/poseidon4.circom" },
  { name: "Poseidon(5)", file: "circuit-probes/poseidon5.circom" },
  { name: "MerkleProof(20)", file: materializeMerkleProbe() },
  { name: "Num2Bits(64)", file: "circuit-probes/num2bits64.circom" },
  { name: "Num2Bits(8)", file: "circuit-probes/num2bits8.circom" },
  { name: "GreaterThan(64)", file: "circuit-probes/gt64.circom" },
  { name: "LessEqThan(64)", file: "circuit-probes/leq64.circom" },
  { name: "GreaterEqThan(64)", file: "circuit-probes/geq64.circom" },
  { name: "GreaterEqThan(8)", file: "circuit-probes/geq8.circom" },
];

// Exact gadget multiplicity per real circuit, read directly off
// transfer.circom / compliance.circom / withdraw.circom (see those files for
// the line-by-line mapping cited in the experiment report).
const RECIPES = {
  transfer: {
    "Poseidon(2)": 0, "Poseidon(3)": 1, "Poseidon(4)": 3, "Poseidon(5)": 0,
    "MerkleProof(20)": 1, "Num2Bits(64)": 4, "Num2Bits(8)": 0,
    "GreaterThan(64)": 1, "LessEqThan(64)": 1, "GreaterEqThan(64)": 0, "GreaterEqThan(8)": 0,
  },
  compliance: {
    "Poseidon(2)": 0, "Poseidon(3)": 2, "Poseidon(4)": 0, "Poseidon(5)": 1,
    "MerkleProof(20)": 1, "Num2Bits(64)": 3, "Num2Bits(8)": 2,
    "GreaterThan(64)": 0, "LessEqThan(64)": 0, "GreaterEqThan(64)": 1, "GreaterEqThan(8)": 1,
  },
  withdraw: {
    // Num2Bits(64) x3: amountBits, cumBits, remBits (NOT 4 - there is no
    // separate range check on newCommitment itself, only on the plaintext
    // remainingBalance that feeds it).
    "Poseidon(2)": 1, "Poseidon(3)": 0, "Poseidon(4)": 3, "Poseidon(5)": 0,
    "MerkleProof(20)": 0, "Num2Bits(64)": 3, "Num2Bits(8)": 0,
    "GreaterThan(64)": 1, "LessEqThan(64)": 1, "GreaterEqThan(64)": 0, "GreaterEqThan(8)": 0,
  },
};

const REAL_CIRCUITS = [
  { name: "transfer", file: join(CIRCUITS_DIR, "transfer.circom") },
  { name: "compliance", file: join(CIRCUITS_DIR, "compliance.circom") },
  { name: "withdraw", file: join(CIRCUITS_DIR, "withdraw.circom") },
];

function main() {
  console.log("=== Veil constraint attribution (circom2 " + circom2Version() + ") ===\n");

  console.log("--- Isolated gadget probes (scripts/bench/circuit-probes/*.circom) ---");
  const probeResults = {};
  for (const probe of PROBES) {
    const r = compile(probe.file, { libs: [join(CIRCUITS_DIR, "node_modules"), join(BENCH_DIR, "node_modules")] });
    probeResults[probe.name] = r;
    console.log(`${probe.name.padEnd(20)} non-linear: ${String(r.nonLinear).padStart(6)}   linear: ${String(r.linear).padStart(6)}   wires: ${String(r.wires).padStart(6)}`);
  }

  console.log("\n--- Real circuits, recompiled fresh tonight with circom2 ---");
  const realResults = {};
  for (const c of REAL_CIRCUITS) {
    const r = compile(c.file, { cwd: CIRCUITS_DIR, libs: [join(CIRCUITS_DIR, "node_modules")] });
    realResults[c.name] = r;
    console.log(`${c.name.padEnd(12)} non-linear: ${String(r.nonLinear).padStart(6)}   linear: ${String(r.linear).padStart(6)}   wires: ${String(r.wires).padStart(6)}`);
  }

  console.log("\n--- Predicted vs. actual non-linear constraints (sum of probe costs x recipe multiplicity) ---");
  for (const [circuitName, recipe] of Object.entries(RECIPES)) {
    let predicted = 0;
    const parts = [];
    for (const [gadget, count] of Object.entries(recipe)) {
      if (count === 0) continue;
      const cost = probeResults[gadget].nonLinear * count;
      predicted += cost;
      parts.push(`${count}x${gadget}=${cost}`);
    }
    const actual = realResults[circuitName].nonLinear;
    const delta = actual - predicted;
    const deltaPct = ((delta / actual) * 100).toFixed(1);
    console.log(`\n${circuitName}.circom:`);
    console.log(`  ${parts.join(" + ")}`);
    console.log(`  predicted (sum of isolated probes): ${predicted}`);
    console.log(`  actual (fresh compile):             ${actual}`);
    console.log(`  delta (glue logic: C3/C6 additions, boolean checks, MultiMux1 selectors not separately probed): ${delta} (${deltaPct}%)`);
  }

  console.log("\n=== Summary (JSON) ===");
  console.log(JSON.stringify({ probes: probeResults, real: realResults }, null, 2));
}

function circom2Version() {
  try {
    return execFileSync("node", [CIRCOM2_CLI, "--version"], { encoding: "utf8" }).trim().split("\n").pop();
  } catch {
    return "unknown";
  }
}

main();
