#!/usr/bin/env node
/**
 * poseidon-arity-latency.mjs — Node-side Groth16 proving-time benchmark for the standalone
 * single-hash circuits under circuits/bench-circuits/ (circomlib Poseidon vs @taceo/circom-lib
 * Poseidon2, at matching input arities).
 *
 * Each circuit computes exactly one hash call with no other constraints, so there is no
 * correctness relation to satisfy beyond "the wasm computed something" — inputs are arbitrary
 * field elements (1, 2, 3, ...), not derived from any protocol witness.
 *
 * Usage:
 *   node scripts/bench/poseidon-arity-latency.mjs [--runs N]
 *
 * Prerequisite (produces the artifacts this script reads):
 *   bash scripts/bench/poseidon-arity-compile.sh
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const BUILD_DIR = join(CIRCUITS_DIR, "bench-build");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 20;
})();

// name -> number of `in[]` signal inputs the circuit's main component expects
const CIRCUITS = [
  { name: "poseidon_t2", kind: "Poseidon(2) sponge      [circomlib]", nInputs: 2 },
  { name: "poseidon_t3", kind: "Poseidon(3) sponge      [circomlib]", nInputs: 3 },
  { name: "poseidon_t4", kind: "Poseidon(4) sponge      [circomlib]", nInputs: 4 },
  { name: "poseidon_t5", kind: "Poseidon(5) sponge      [circomlib]", nInputs: 5 },
  { name: "poseidon2_t3", kind: "Poseidon2 t=3 sponge (2 in) [taceo]", nInputs: 2 },
  { name: "poseidon2_t4", kind: "Poseidon2 t=4 sponge (3 in) [taceo]", nInputs: 3 },
  { name: "poseidon2_compress2", kind: "Poseidon2 t=2 COMPRESS (2 in, feed-fwd) [taceo]", nInputs: 2 },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) {
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

async function main() {
  console.log(`=== Veil Poseidon vs Poseidon2 proving-time benchmark (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const results = [];

  for (const circuit of CIRCUITS) {
    const wasmPath = join(BUILD_DIR, `${circuit.name}_js`, `${circuit.name}.wasm`);
    const zkeyPath = join(BUILD_DIR, `${circuit.name}_final.zkey`);
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      console.log(`[SKIP] ${circuit.name}: artifacts not found — run poseidon-arity-compile.sh first`);
      continue;
    }

    const input = { in: Array.from({ length: circuit.nInputs }, (_, i) => i + 1) };

    // Warm-up (pays one-time WASM instantiation cost, not counted)
    await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);

    const times = [];
    for (let i = 0; i < RUNS; i++) {
      const start = process.hrtime.bigint();
      await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
      const end = process.hrtime.bigint();
      times.push(Number(end - start) / 1e6);
    }

    const m = mean(times);
    const sd = stddev(times, m);
    results.push({ name: circuit.name, kind: circuit.kind, mean: m, stddev: sd, min: Math.min(...times), max: Math.max(...times) });

    console.log(`--- ${circuit.name}  (${circuit.kind}) ---`);
    console.log(`  runs: ${RUNS}`);
    console.log(`  mean: ${m.toFixed(2)} ms   stddev: ${sd.toFixed(2)} ms   min: ${Math.min(...times).toFixed(2)} ms   max: ${Math.max(...times).toFixed(2)} ms\n`);
  }

  console.log("=== Summary ===");
  console.table(results.map(r => ({
    circuit: r.name,
    kind: r.kind,
    "mean (ms)": r.mean.toFixed(2),
    "stddev (ms)": r.stddev.toFixed(2),
  })));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
