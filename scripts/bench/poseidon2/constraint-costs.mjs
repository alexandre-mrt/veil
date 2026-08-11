#!/usr/bin/env node
/**
 * constraint-costs.mjs — per-component R1CS cost measurement for the Poseidon2 experiment.
 *
 * Compiles every isolated single-component circuit in scripts/bench/poseidon2/circuits/
 * with circom (--r1cs only) and reads constraint counts straight from the compiler's own
 * summary plus `snarkjs r1cs info`, then prints one table. No estimates: every row is a
 * real compile of a real .circom file.
 *
 * Usage:
 *   node scripts/bench/poseidon2/constraint-costs.mjs
 *
 * Prerequisites:
 *   - `circom` on PATH (or set CIRCOM=/path/to/circom), same 2.2.x used for production builds
 *   - `cd circuits && npm install` (circomlib + snarkjs)
 */
import { execFileSync } from "child_process";
import { mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");
const CIRCUITS_NM = join(REPO, "circuits", "node_modules");
const require_ = createRequire(join(REPO, "circuits", "package.json"));
const snarkjs = await import(require_.resolve("snarkjs"));

const CIRCOM = process.env.CIRCOM || "circom";
const SRC = join(__dirname, "circuits");
const BUILD = join(__dirname, "build");
mkdirSync(BUILD, { recursive: true });

// Include roots: circomlib (via circuits/node_modules), the production Merkle template,
// and the vendored Poseidon2 implementation.
const INCLUDES = [
  CIRCUITS_NM,
  join(REPO, "circuits", "templates"),
  join(__dirname, "vendor"),
];

const files = readdirSync(SRC).filter((f) => f.endsWith(".circom")).sort();
const rows = [];

for (const f of files) {
  const name = f.replace(/\.circom$/, "");
  const out = join(BUILD, name);
  mkdirSync(out, { recursive: true });
  const args = [join(SRC, f), "--r1cs", "--output", out];
  for (const inc of INCLUDES) args.push("-l", inc);
  const circomOut = execFileSync(CIRCOM, args, { encoding: "utf8" });
  const grab = (re) => {
    const m = circomOut.match(re);
    return m ? parseInt(m[1], 10) : NaN;
  };
  const nonLinear = grab(/non-linear constraints:\s*(\d+)/);
  const linear = grab(/linear constraints:\s*(\d+)/);
  const info = await snarkjs.r1cs.info(join(out, `${name}.r1cs`));
  rows.push({
    name,
    constraints: Number(info.nConstraints),
    nonLinear,
    linear,
    wires: Number(info.nVars),
  });
}

console.log(`=== Per-component R1CS costs (circom ${execFileSync(CIRCOM, ["--version"], { encoding: "utf8" }).trim().replace(/circom compiler\s*/, "")}, default optimization) ===\n`);
const pad = (s, n) => String(s).padStart(n);
console.log(`${"circuit".padEnd(22)} ${pad("total", 7)} ${pad("non-linear", 11)} ${pad("linear", 7)} ${pad("wires", 7)}`);
for (const r of rows) {
  console.log(`${r.name.padEnd(22)} ${pad(r.constraints, 7)} ${pad(r.nonLinear, 11)} ${pad(r.linear, 7)} ${pad(r.wires, 7)}`);
}

// snarkjs keeps a curve worker pool alive after r1cs info; exit explicitly.
process.exit(0);
