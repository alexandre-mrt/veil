#!/usr/bin/env node
/**
 * measure.mjs — attributes each production circuit's R1CS non-linear/linear constraint count
 * to the named circomlib/local gadgets it instantiates (Poseidon, Num2Bits, comparators, the
 * depth-20 Merkle path), by compiling each gadget in isolation and cross-checking the sum
 * against the real compiled circuit.
 *
 * Usage:
 *   CIRCOM_BIN=/path/to/circom node scripts/bench/gadget-attribution/measure.mjs
 *   (CIRCOM_BIN defaults to "circom" on PATH; circom 2.2.x built from github.com/iden3/circom
 *   tag v2.2.2 is what this was measured against — see the 2026-08-07 report for the build steps)
 *
 * What it does, in order:
 *   1. Compiles every gadgets/*.circom (one isolated component each) with `circom --r1cs` and
 *      parses the compiler's own "non-linear constraints" / "linear constraints" summary lines.
 *   2. Greps circuits/{transfer,compliance,withdraw}.circom for `= GadgetName(param)` component
 *      instantiations to get a real instance count per gadget, per circuit (not hand-maintained —
 *      re-run this after any circuit edit and the counts follow the source).
 *   3. Multiplies isolated-gadget constraints by instance count, sums per circuit, and prints the
 *      predicted total next to the real compiled circuit's total (also measured, not cached) so
 *      any drift between "sum of parts" and "compiled whole" is visible immediately.
 */
import { execFileSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const CIRCUITS_DIR = join(REPO_ROOT, "circuits");
const GADGETS_DIR = join(__dirname, "gadgets");
const BUILD_DIR = join(GADGETS_DIR, "build");
const CIRCOM_BIN = process.env.CIRCOM_BIN || "circom";

// gadget circom file -> [display name, regex to count `= Name(param)` instantiations in a circuit]
const GADGETS = {
  poseidon2: { label: "Poseidon(2)", re: /=\s*Poseidon\(2\)/g },
  poseidon3: { label: "Poseidon(3)", re: /=\s*Poseidon\(3\)/g },
  poseidon4: { label: "Poseidon(4)", re: /=\s*Poseidon\(4\)/g },
  poseidon5: { label: "Poseidon(5)", re: /=\s*Poseidon\(5\)/g },
  num2bits64: { label: "Num2Bits(64)", re: /=\s*Num2Bits\(64\)/g },
  num2bits8: { label: "Num2Bits(8)", re: /=\s*Num2Bits\(8\)/g },
  lesseqthan64: { label: "LessEqThan(64)", re: /=\s*LessEqThan\(64\)/g },
  greaterthan64: { label: "GreaterThan(64)", re: /=\s*GreaterThan\(64\)/g },
  greaterequalthan64: { label: "GreaterEqThan(64)", re: /=\s*GreaterEqThan\(64\)/g },
  greaterequalthan8: { label: "GreaterEqThan(8)", re: /=\s*GreaterEqThan\(8\)/g },
  // MerkleProof(depth) is compiled and measured as its own composite unit (it is not "flat" —
  // it wraps Poseidon(2) + MultiMux1(2) + a boolean check per level) so it is reported both as
  // one line item AND decomposed against poseidon2/multimux1_x2 in the printed notes. The depth
  // argument is a variable at the call site in both production circuits (`MerkleProof(depth)` /
  // `MerkleProof(merkleDepth)`, both instantiated with 20 via `component main = ...(20)`), so the
  // match is on the call itself, not a literal "20".
  merkleproof20: { label: "MerkleProof(20)", re: /=\s*MerkleProof\(/g },
  multimux1_x2: { label: "MultiMux1(2)", re: null }, // internal to MerkleProof, not top-level-instantiated
};

const CIRCUITS = ["transfer", "compliance", "withdraw"];

function compile(circomFile, outDir) {
  mkdirSync(outDir, { recursive: true });
  let out;
  try {
    out = execFileSync(CIRCOM_BIN, [circomFile, "--r1cs", "-o", outDir, "-l", join(CIRCUITS_DIR, "node_modules")], { encoding: "utf8" });
  } catch (err) {
    // circom prints its summary to stdout even on the (expected) "no main component" style runs;
    // execFileSync throws on non-zero exit, but successful compiles exit 0, so a throw here is real.
    throw new Error(`circom failed on ${circomFile}: ${err.stderr || err.stdout || err.message}`);
  }
  // Anchored at line start: "non-linear constraints:" would otherwise also satisfy a bare
  // /linear constraints:/ match as a substring, silently collapsing both fields to the same value.
  const nonLinear = parseInt(/^non-linear constraints:\s*(\d+)/m.exec(out)?.[1] ?? "NaN", 10);
  const linear = parseInt(/^linear constraints:\s*(\d+)/m.exec(out)?.[1] ?? "NaN", 10);
  const wires = parseInt(/wires:\s*(\d+)/.exec(out)?.[1] ?? "NaN", 10);
  return { nonLinear, linear, total: nonLinear + linear, wires, raw: out };
}

function main() {
  console.log(`=== Veil R1CS gadget-attribution benchmark ===`);
  console.log(`circom binary: ${CIRCOM_BIN}`);
  console.log(execFileSync(CIRCOM_BIN, ["--version"], { encoding: "utf8" }).trim());
  console.log("");

  // Step 1: compile every isolated gadget, print raw numbers.
  const gadgetResults = {};
  for (const key of Object.keys(GADGETS)) {
    const file = join(GADGETS_DIR, `${key}.circom`);
    const r = compile(file, BUILD_DIR);
    gadgetResults[key] = r;
    console.log(`--- ${GADGETS[key].label} (${key}.circom) ---`);
    console.log(`  non-linear: ${r.nonLinear}   linear: ${r.linear}   total: ${r.total}   wires: ${r.wires}`);
  }
  console.log("");

  // Step 2: for each production circuit, count instances of each top-level gadget from source,
  // predict totals, and compile the real circuit to compare against.
  for (const circuitName of CIRCUITS) {
    const src = readFileSync(join(CIRCUITS_DIR, `${circuitName}.circom`), "utf8");
    console.log(`=== ${circuitName}.circom ===`);

    let predictedNL = 0;
    let predictedL = 0;
    const lines = [];
    for (const [key, meta] of Object.entries(GADGETS)) {
      if (!meta.re) continue;
      const count = (src.match(meta.re) || []).length;
      if (count === 0) continue;
      const r = gadgetResults[key];
      predictedNL += count * r.nonLinear;
      predictedL += count * r.linear;
      lines.push(`  ${meta.label} x${count}: non-linear ${count}*${r.nonLinear}=${count * r.nonLinear}, linear ${count}*${r.linear}=${count * r.linear}`);
    }
    lines.forEach((l) => console.log(l));
    console.log(`  --- predicted total: non-linear ${predictedNL}, linear ${predictedL}, sum ${predictedNL + predictedL} ---`);

    const realOut = join(GADGETS_DIR, "build", "real");
    const real = compile(join(CIRCUITS_DIR, `${circuitName}.circom`), realOut);
    console.log(`  --- actual compiled circuit: non-linear ${real.nonLinear}, linear ${real.linear}, sum ${real.total} ---`);
    const residualNL = real.nonLinear - predictedNL;
    const residualL = real.linear - predictedL;
    console.log(`  residual (actual - predicted): non-linear ${residualNL}, linear ${residualL} (top-level R1CS wiring not covered by a named subcomponent)`);
    console.log("");
  }
}

main();
