#!/usr/bin/env node
/**
 * poseidon2-prove-latency.mjs — Node-side Groth16 proving-time benchmark for the six
 * circuits/bench/*.circom circuits (three Veil hash shapes x {current, poseidon2}).
 * Same methodology as prove-latency.mjs: wall-clock snarkjs.groth16.fullProve, one
 * discarded warm-up run, N timed runs, mean/stddev/min/max.
 *
 * Usage:
 *   node scripts/bench/poseidon2-prove-latency.mjs [--runs N]
 *
 * Prerequisite (produces the artifacts this script reads):
 *   cd circuits && bash scripts/compile-poseidon2-bench.sh
 */
import { buildPoseidon } from "circomlibjs";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { BENCH_WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "./poseidon2-bench-witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const BENCH_DIR = join(CIRCUITS_DIR, "build-bench");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

const CIRCUITS = [
  "transfer_hash_current",
  "transfer_hash_poseidon2",
  "compliance_hash_current",
  "compliance_hash_poseidon2",
  "withdraw_hash_current",
  "withdraw_hash_poseidon2",
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) {
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);

  console.log(`=== Veil Poseidon2 bench: Groth16 proving-time (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const results = [];

  for (const name of CIRCUITS) {
    const wasmPath = join(BENCH_DIR, name, `${name}_js`, `${name}.wasm`);
    const zkeyPath = join(BENCH_DIR, name, `${name}_final.zkey`);
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      console.log(`[SKIP] ${name}: artifacts not found (${wasmPath})`);
      continue;
    }

    const inputs = stringifyInputs(BENCH_WITNESS_BUILDERS[name](poseidon));
    const times = [];

    const warm = await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
    const proofBytesJson = Buffer.byteLength(JSON.stringify(warm.proof));
    const publicSignalsCount = warm.publicSignals.length;

    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
      const t1 = process.hrtime.bigint();
      times.push(Number(t1 - t0) / 1e6);
    }

    const m = mean(times);
    const sd = stddev(times, m);
    results.push({
      circuit: name, runs: RUNS, meanMs: m, stddevMs: sd,
      minMs: Math.min(...times), maxMs: Math.max(...times),
      proofBytesJson, publicSignalsCount,
    });

    console.log(`--- ${name} ---`);
    console.log(`  runs: ${RUNS}`);
    console.log(`  mean: ${m.toFixed(2)} ms   stddev: ${sd.toFixed(2)} ms   min: ${Math.min(...times).toFixed(2)} ms   max: ${Math.max(...times).toFixed(2)} ms`);
    console.log(`  proof JSON size: ${proofBytesJson} bytes, public signals: ${publicSignalsCount}`);
    console.log("");
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
