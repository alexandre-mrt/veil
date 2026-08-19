#!/usr/bin/env node
/**
 * poseidon2-prove-latency.mjs — Groth16 proving-time benchmark for the Poseidon-vs-Poseidon2
 * arity comparison (docs/research/2026-08-19-poseidon2-arity-benchmark.md).
 *
 * Measures wall-clock snarkjs.groth16.fullProve time (witness generation + proving) for each
 * of the eight standalone benchmark circuits in circuits/research/poseidon2/bench/, at Veil's
 * actual hash arities (2, 3, 4, 5 inputs), comparing circomlib's Poseidon against the vendored
 * Poseidon2 (direct for arities with native round constants, zero-padded to t=8 for the two
 * arities the vendored library has none for).
 *
 * Usage:
 *   bash scripts/bench/poseidon2-bench-setup.sh   # compiles circuits + builds zkeys, once
 *   node scripts/bench/poseidon2-prove-latency.mjs [--runs N]
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "..", "..", "circuits", "research", "poseidon2", "bench", "build");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

const CIRCUITS = [
  { name: "poseidon_n2", nInputs: 2, family: "Poseidon (circomlib)" },
  { name: "poseidon2_n2", nInputs: 2, family: "Poseidon2 (t=3, native)" },
  { name: "poseidon_n3", nInputs: 3, family: "Poseidon (circomlib)" },
  { name: "poseidon2_n3", nInputs: 3, family: "Poseidon2 (t=4, native)" },
  { name: "poseidon_n4", nInputs: 4, family: "Poseidon (circomlib)" },
  { name: "poseidon2_n4_padded_t8", nInputs: 4, family: "Poseidon2 (t=8, padded)" },
  { name: "poseidon_n5", nInputs: 5, family: "Poseidon (circomlib)" },
  { name: "poseidon2_n5_padded_t8", nInputs: 5, family: "Poseidon2 (t=8, padded)" },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) {
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

async function main() {
  console.log(`=== Poseidon vs Poseidon2 arity benchmark: proving time (${RUNS} runs each) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const results = [];

  for (const c of CIRCUITS) {
    const wasmPath = join(BUILD_DIR, `${c.name}_js`, `${c.name}.wasm`);
    const zkeyPath = join(BUILD_DIR, `${c.name}_final.zkey`);
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      console.log(`[SKIP] ${c.name}: artifacts not found — run poseidon2-bench-setup.sh first`);
      continue;
    }

    const inputs = { inputs: Array.from({ length: c.nInputs }, (_, i) => String(i + 1)) };
    const times = [];

    const warm = await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
    const proofBytesJson = Buffer.byteLength(JSON.stringify(warm.proof));

    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
      const t1 = process.hrtime.bigint();
      times.push(Number(t1 - t0) / 1e6);
    }

    const m = mean(times);
    const sd = stddev(times, m);
    results.push({ circuit: c.name, family: c.family, nInputs: c.nInputs, runs: RUNS, meanMs: m, stddevMs: sd, proofBytesJson });

    console.log(`--- ${c.name} (${c.family}, ${c.nInputs} inputs) ---`);
    console.log(`  mean: ${m.toFixed(3)} ms   stddev: ${sd.toFixed(3)} ms   min: ${Math.min(...times).toFixed(3)} ms   max: ${Math.max(...times).toFixed(3)} ms`);
    console.log("");
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));
}

main()
  .then(() => process.exit(0)) // snarkjs/ffjavascript leaves a curve-worker handle open otherwise
  .catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
