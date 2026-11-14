#!/usr/bin/env node
/**
 * r1cs-density.mjs — count non-zero coefficients in the A, B, C matrices of every R1CS that
 * bench.mjs built (build/O1/*.r1cs, build/O2/*.r1cs). Constraint count alone does not predict
 * snarkjs proving time once circom -O2 folds linear constraints into dense non-linear ones.
 *
 * Usage: node scripts/bench/hash-arity/r1cs-density.mjs
 */
import { readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readR1cs } from "r1csfile";

const here = dirname(fileURLToPath(import.meta.url));
const rows = [];
for (const opt of ["O1", "O2"]) {
  const dir = join(here, "build", opt);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".r1cs")).sort()) {
    const r = await readR1cs(join(dir, f), { loadConstraints: true, loadMap: false, singleThread: true });
    let a = 0, b = 0, c = 0;
    for (const [A, B, C] of r.constraints) { a += Object.keys(A).length; b += Object.keys(B).length; c += Object.keys(C).length; }
    rows.push({ circuit: f.replace(".r1cs", ""), opt, constraints: r.nConstraints, wires: r.nVars, nnzA: a, nnzB: b, nnzC: c, nnzTotal: a + b + c });
    if (r.curve && r.curve.terminate) await r.curve.terminate();
  }
}
console.log("circuit".padEnd(20), "opt", "constraints".padStart(11), "wires".padStart(7), "nnzA".padStart(8), "nnzB".padStart(8), "nnzC".padStart(8), "nnzTotal".padStart(9));
for (const r of rows) console.log(r.circuit.padEnd(20), r.opt.padEnd(3), String(r.constraints).padStart(11), String(r.wires).padStart(7), String(r.nnzA).padStart(8), String(r.nnzB).padStart(8), String(r.nnzC).padStart(8), String(r.nnzTotal).padStart(9));
process.exit(0);
