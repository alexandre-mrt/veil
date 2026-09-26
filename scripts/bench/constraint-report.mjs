#!/usr/bin/env node
/**
 * constraint-report.mjs — Reusable R1CS constraint-count diff for Veil circuit variants.
 *
 * Runs `snarkjs r1cs info` on a list of compiled .r1cs files and prints a comparison table
 * (non-linear / linear / total constraints, wires) plus percentage deltas against the first
 * entry ("baseline"). Built for the Poseidon2 Merkle-path experiment
 * (docs/research/2026-09-26-poseidon2-merkle-path.md) but takes an arbitrary list of circuits,
 * so any future circuit-variant comparison in this research loop can reuse it instead of
 * eyeballing `snarkjs r1cs info` output by hand.
 *
 * Usage:
 *   node scripts/bench/constraint-report.mjs <label1>:<r1cs1> <label2>:<r1cs2> ...
 *
 * Example (this experiment):
 *   node scripts/bench/constraint-report.mjs \
 *     "transfer (Poseidon)":circuits/build/transfer.r1cs \
 *     "transfer_poseidon2":circuits/build-poseidon2/transfer_poseidon2.r1cs
 */
import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

function parseR1csInfo(r1csPath) {
  const cmd = `npx snarkjs r1cs info ${JSON.stringify(r1csPath)}`;
  const out = execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8" });
  const grab = (label) => {
    const m = out.match(new RegExp(`# of ${label}:\\s*(\\d+)`));
    return m ? parseInt(m[1], 10) : null;
  };
  return {
    wires: grab("Wires"),
    constraints: grab("Constraints"),
    privateInputs: grab("Private Inputs"),
    publicInputs: grab("Public Inputs"),
    raw: out,
    cmd,
  };
}

// snarkjs r1cs info's "# of Constraints" is the total (linear + non-linear). To get the
// non-linear/linear split (the number that actually predicts prover cost) we also need the
// compiler's own stderr summary, which only prints at compile time — so this script additionally
// accepts a pre-captured `circom` compile log per entry via a sibling `.compile.log` file if
// present (written by whoever ran the compile), and falls back to total-only otherwise.
function tryReadCompileLog(r1csPath) {
  const logPath = r1csPath.replace(/\.r1cs$/, ".compile.log");
  if (!existsSync(logPath)) return null;
  const text = execSync(`cat ${JSON.stringify(logPath)}`, { encoding: "utf8" });
  const nl = text.match(/non-linear constraints:\s*(\d+)/);
  const lin = text.match(/linear constraints:\s*(\d+)/);
  return nl && lin ? { nonLinear: parseInt(nl[1], 10), linear: parseInt(lin[1], 10) } : null;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: node scripts/bench/constraint-report.mjs <label>:<r1cs path> ...");
    process.exit(1);
  }

  const entries = args.map((arg) => {
    const idx = arg.indexOf(":");
    if (idx === -1) throw new Error(`Bad argument (expected label:path): ${arg}`);
    const label = arg.slice(0, idx);
    const r1csPath = resolve(REPO_ROOT, arg.slice(idx + 1));
    if (!existsSync(r1csPath)) throw new Error(`r1cs not found: ${r1csPath}`);
    return { label, r1csPath };
  });

  console.log("=== Veil constraint-count comparison (snarkjs r1cs info) ===\n");

  const rows = entries.map(({ label, r1csPath }) => {
    const info = parseR1csInfo(r1csPath);
    const split = tryReadCompileLog(r1csPath);
    console.log(`$ ${info.cmd}`);
    console.log(info.raw.trim());
    console.log("");
    return { label, r1csPath, ...info, ...split };
  });

  const baseline = rows[0];
  console.log("=== Summary ===");
  console.log(
    "| Circuit | Total constraints | Non-linear | Linear | Wires | Δ total vs baseline |",
  );
  console.log("|---|---|---|---|---|---|");
  for (const row of rows) {
    const deltaTotal =
      row === baseline
        ? "—"
        : `${row.constraints - baseline.constraints >= 0 ? "+" : ""}${
            row.constraints - baseline.constraints
          } (${(((row.constraints - baseline.constraints) / baseline.constraints) * 100).toFixed(2)}%)`;
    console.log(
      `| ${row.label} | ${row.constraints} | ${row.nonLinear ?? "n/a"} | ${row.linear ?? "n/a"} | ${row.wires} | ${deltaTotal} |`,
    );
  }
}

main();
