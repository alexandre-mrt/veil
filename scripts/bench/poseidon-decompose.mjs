#!/usr/bin/env node
/**
 * poseidon-decompose.mjs — decomposes Veil's R1CS non-linear/linear constraint counts
 * into per-gadget contributions (Poseidon arity 2/3/4/5, Num2Bits 64/8, the three
 * comparators, MultiMux1(2), and the depth-20 MerkleProof), then reconstructs each
 * production circuit's total from gadget multiplicities and diffs against BASELINE.md.
 *
 * Answers EXPERIMENTS.md queue item #2's "re-derive the exact non-linear-constraint
 * contribution per Poseidon instance from the current baseline" framing.
 *
 * Usage:
 *   CIRCOM_BIN=/path/to/circom node scripts/bench/poseidon-decompose.mjs
 *
 * Prerequisite: circuits/node_modules installed (npm install in circuits/) and a
 * circom 2.1.x/2.2.x binary (CIRCOM_BIN env var, defaults to "circom" on PATH).
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const PROBES_DIR = join(CIRCUITS_DIR, "bench-probes");
const BUILD_DIR = join(PROBES_DIR, "build");
const CIRCOM_BIN = process.env.CIRCOM_BIN || "circom";

// Gadget name -> probe file. Each probe wraps exactly one circomlib component
// instantiation with the same arity/parameters used in transfer.circom /
// compliance.circom / withdraw.circom, wired to public in/outputs so nothing
// is dead-code-eliminated.
const PROBES = [
  { key: "Poseidon(2)", file: "probe_poseidon2.circom" },
  { key: "Poseidon(3)", file: "probe_poseidon3.circom" },
  { key: "Poseidon(4)", file: "probe_poseidon4.circom" },
  { key: "Poseidon(5)", file: "probe_poseidon5.circom" },
  { key: "Num2Bits(64)", file: "probe_num2bits64.circom" },
  { key: "Num2Bits(8)", file: "probe_num2bits8.circom" },
  { key: "GreaterThan(64)", file: "probe_greaterthan64.circom" },
  { key: "LessEqThan(64)", file: "probe_lesseqthan64.circom" },
  { key: "GreaterEqThan(64)", file: "probe_greaterequalthan64.circom" },
  { key: "GreaterEqThan(8)", file: "probe_greaterequalthan8.circom" },
  { key: "MultiMux1(2)", file: "probe_multimux1.circom" },
  { key: "MerkleProof(20)", file: "probe_merkleproof20.circom" },
];

// Gadget multiplicities per production circuit, read directly off transfer.circom /
// compliance.circom / withdraw.circom source (one row per `component X = Gadget(...)`
// instantiation actually present in the compiled circuit).
const RECONSTRUCTION = {
  "transfer.circom": {
    "MerkleProof(20)": 1,
    "Poseidon(4)": 3, // oldHash, newHash, nfHash
    "Poseidon(3)": 1, // txHash
    "GreaterThan(64)": 1, // gtZero
    "Num2Bits(64)": 4, // oldBits, txBits, newBits, threshBits
    "LessEqThan(64)": 1, // ltThreshold
  },
  "compliance.circom": {
    "Poseidon(5)": 1, // leafHash
    "MerkleProof(20)": 1,
    "Poseidon(3)": 2, // nfHash, ctxHash
    "GreaterEqThan(64)": 1, // expiryCheck
    "GreaterEqThan(8)": 1, // kycCheck
    "Num2Bits(64)": 3, // epochBits, expiryBits, issuerBits
    "Num2Bits(8)": 2, // kycBits, reqKycBits
  },
  "withdraw.circom": {
    "Poseidon(4)": 3, // commHash, changeHash, nfHash
    "Poseidon(2)": 1, // recipHash
    "Num2Bits(64)": 3, // amountBits, cumBits, remBits
    "GreaterThan(64)": 1, // gtZero
    "LessEqThan(64)": 1, // amountCheck
  },
};

// Actual measured totals, from docs/research/BASELINE.md (2026-07-22 run, reconfirmed
// this run with a fresh circom 2.2.2 build — see the 2026-08-01 report).
const ACTUAL = {
  "transfer.circom": { nl: 6470, l: 7141 },
  "compliance.circom": { nl: 6057, l: 6686 },
  "withdraw.circom": { nl: 1465, l: 1593 },
};

// Top-level glue outside any named gadget instantiation — `===`/`<==` statements
// circom's own signal graph, not a circomlib component. Circom's default
// simplification (-O1) eliminates a pure signal-to-signal alias (e.g.
// `oldCommitment === oldHash.out`) or a signal-fixed-to-constant (e.g.
// `gtZero.out === 1`) at zero extra R1CS rows — the signal gets substituted away
// wherever it's used. It CANNOT eliminate an assignment that computes a genuine
// linear combination (e.g. `cumulativeNew === cumulativeOld + txAmount`), which
// costs exactly one linear row, or a product of two signals (e.g.
// `computedValid <== expiryCheck.out * kycCheck.out`), which costs one non-linear
// row. Verified by matching this table to each circuit's exact residual below —
// if a future circuit edit makes the residual nonzero, this table is stale and
// needs a new line added, not a fudge to the numbers.
const GLUE = {
  "transfer.circom": {
    nl: 0,
    l: 1, // `cumulativeNew === cumulativeOld + txAmount` (linear combination)
  },
  "compliance.circom": {
    nl: 3, // two `x.out * (1 - x.out) === 0` binary checks + `computedValid <== expiryCheck.out * kycCheck.out`
    l: 0,
  },
  "withdraw.circom": {
    nl: 0,
    l: 1, // `remainingBalance <== cumulativeOld - withdrawAmount` (linear combination)
  },
};

function compileProbe(file) {
  const out = execFileSync(
    CIRCOM_BIN,
    [join(PROBES_DIR, file), "--r1cs", "--output", BUILD_DIR],
    { encoding: "utf8" }
  );
  return out;
}

function circomConstraintCounts(compileOutput) {
  const nl = parseInt(compileOutput.match(/non-linear constraints:\s*(\d+)/)[1], 10);
  const l = parseInt(compileOutput.match(/(?<!non-)linear constraints:\s*(\d+)/)[1], 10);
  const wires = parseInt(compileOutput.match(/wires:\s*(\d+)/)[1], 10);
  return { nl, l, wires };
}

function main() {
  if (!existsSync(join(CIRCUITS_DIR, "node_modules", "circomlib"))) {
    console.error("circomlib not found — run `npm install` in circuits/ first.");
    process.exit(1);
  }
  rmSync(BUILD_DIR, { recursive: true, force: true });
  mkdirSync(BUILD_DIR, { recursive: true });

  const gadgetCounts = {};
  console.log("=== Per-gadget isolated constraint counts ===\n");
  for (const probe of PROBES) {
    const out = compileProbe(probe.file);
    const counts = circomConstraintCounts(out);
    gadgetCounts[probe.key] = counts;
    console.log(
      `${probe.key.padEnd(20)} non-linear: ${String(counts.nl).padStart(5)}  linear: ${String(
        counts.l
      ).padStart(5)}  wires: ${counts.wires}`
    );
  }

  console.log("\n=== Reconstruction vs BASELINE.md ===\n");
  for (const [circuit, mult] of Object.entries(RECONSTRUCTION)) {
    let sumNl = 0;
    let sumL = 0;
    for (const [gadget, count] of Object.entries(mult)) {
      sumNl += gadgetCounts[gadget].nl * count;
      sumL += gadgetCounts[gadget].l * count;
    }
    const glue = GLUE[circuit];
    sumNl += glue.nl;
    sumL += glue.l;
    const actual = ACTUAL[circuit];
    const residualNl = actual.nl - sumNl;
    const residualL = actual.l - sumL;
    console.log(`${circuit}`);
    console.log(
      `  non-linear: gadgets+glue ${sumNl} vs actual ${actual.nl} (residual ${residualNl}${
        residualNl === 0 ? ", fully explained" : ", UNEXPLAINED — update GLUE"
      })`
    );
    console.log(
      `  linear:     gadgets+glue ${sumL} vs actual ${actual.l} (residual ${residualL}${
        residualL === 0 ? ", fully explained" : ", UNEXPLAINED — update GLUE"
      })\n`
    );
  }
}

main();
