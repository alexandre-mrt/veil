#!/usr/bin/env node
/**
 * linear-layer-probe.mjs — proving-time benchmark for the dense-vs-cheap linear-layer probe
 * circuits in circuits/bench/ (see circuits/bench/linear_layer_probe.circom for what these are
 * and are not).
 *
 * Usage:
 *   node scripts/bench/linear-layer-probe.mjs [--runs N]
 *
 * Prerequisite (produces the artifacts this script reads — see the research report for the exact
 * commands used):
 *   cd circuits
 *   <circom> bench/t3_dense.circom --r1cs --wasm --sym --output bench/build -l node_modules
 *   ... (repeat for t3_cheap, t5_dense, t5_cheap)
 *   curl -L -o bench/build/pot10_final.ptau https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_10.ptau
 *   npx snarkjs groth16 setup bench/build/<name>.r1cs bench/build/pot10_final.ptau bench/build/<name>_0000.zkey
 *   npx snarkjs zkey contribute bench/build/<name>_0000.zkey bench/build/<name>_final.zkey --name=veil-bench -v
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = join(__dirname, "..", "..", "circuits", "bench", "build");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 20;
})();

const CIRCUITS = ["t3_dense", "t3_cheap", "t5_dense", "t5_cheap"];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) {
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

function inputsFor(name) {
  const nInputs = name.startsWith("t3") ? 2 : 4;
  const inputs = {};
  for (let i = 0; i < nInputs; i++) inputs[`inputs`] = inputs.inputs || [];
  const arr = [];
  for (let i = 0; i < nInputs; i++) arr.push(String(i + 1));
  return { inputs: arr };
}

async function main() {
  console.log(`=== Veil linear-layer-probe benchmark (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const results = [];
  for (const name of CIRCUITS) {
    const wasmPath = join(BENCH_DIR, `${name}_js`, `${name}.wasm`);
    const zkeyPath = join(BENCH_DIR, `${name}_final.zkey`);
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      console.log(`[SKIP] ${name}: artifacts not found`);
      continue;
    }
    const input = inputsFor(name);
    await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath); // warm-up, discarded (JIT/cache)
    const times = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
      const t1 = process.hrtime.bigint();
      times.push(Number(t1 - t0) / 1e6);
    }
    const m = mean(times);
    const sd = stddev(times, m);
    results.push({ name, mean: m, sd, runs: RUNS });
    console.log(`${name.padEnd(10)} mean ${m.toFixed(2)} ms  (sigma ${sd.toFixed(2)}, ${RUNS} runs)`);
  }

  console.log("\n=== Summary ===");
  for (const t of ["t3", "t5"]) {
    const d = results.find((r) => r.name === `${t}_dense`);
    const c = results.find((r) => r.name === `${t}_cheap`);
    if (d && c) {
      const delta = c.mean - d.mean;
      const pct = (delta / d.mean) * 100;
      console.log(`${t}: dense ${d.mean.toFixed(2)}ms vs cheap ${c.mean.toFixed(2)}ms -> delta ${delta.toFixed(2)}ms (${pct.toFixed(1)}%)`);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
