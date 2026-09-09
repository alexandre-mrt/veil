#!/usr/bin/env node
/**
 * prove-latency-poseidon2.mjs — Node-side Groth16 proving-time benchmark for the Poseidon2
 * experiment circuits (circuits/experiments/poseidon2/{transfer2,compliance2,withdraw2}.circom),
 * measured the same way scripts/bench/prove-latency.mjs measures the production circuits: mean of
 * N runs of a real snarkjs.groth16.fullProve, one warm-up run discarded.
 *
 * Usage:
 *   node scripts/bench/prove-latency-poseidon2.mjs [--runs N]
 *
 * Prerequisites (produces the artifacts this script reads — see the experiment report for the
 * exact commands run to produce tonight's numbers, including how the Powers of Tau file was
 * generated locally rather than downloaded):
 *   cd circuits/experiments/poseidon2
 *   circom transfer2.circom --r1cs --wasm -o build -l ../../node_modules
 *   circom compliance2.circom --r1cs --wasm -o build -l ../../node_modules
 *   circom withdraw2.circom --r1cs --wasm -o build -l ../../node_modules
 *   # Powers of Tau (dev-only, local; see report for why the usual download URL was unreachable):
 *   npx snarkjs powersoftau new bn128 15 ptau/pot15_0000.ptau
 *   npx snarkjs powersoftau contribute ptau/pot15_0000.ptau ptau/pot15_0001.ptau --name=dev
 *   npx snarkjs powersoftau prepare phase2 ptau/pot15_0001.ptau ptau/pot15_final.ptau
 *   # then, per circuit: groth16 setup + zkey contribute (dev-only) + export verificationkey
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { WITNESS_BUILDERS_POSEIDON2, stringifyInputs } from "./witnesses-poseidon2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = join(__dirname, "..", "..", "circuits", "experiments", "poseidon2");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) {
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

async function main() {
  console.log(`=== Veil Poseidon2-experiment Groth16 proving-time benchmark (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const results = [];

  for (const [name, buildWitness] of Object.entries(WITNESS_BUILDERS_POSEIDON2)) {
    const wasmPath = join(EXPERIMENT_DIR, "build", `${name}_js`, `${name}.wasm`);
    const zkeyPath = join(EXPERIMENT_DIR, "build", `${name}_final.zkey`);
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      console.log(`[SKIP] ${name}: artifacts not found (${wasmPath})`);
      continue;
    }

    const witness = stringifyInputs(buildWitness());

    // Warm-up (pays one-time WASM instantiation cost, not counted) — same convention as
    // prove-latency.mjs.
    const warm = await snarkjs.groth16.fullProve(witness, wasmPath, zkeyPath);
    const vk = JSON.parse(await (await import("fs")).promises.readFile(
      join(EXPERIMENT_DIR, "build", `${name}_vk.json`), "utf8"));
    const valid = await snarkjs.groth16.verify(vk, warm.publicSignals, warm.proof);
    if (!valid) {
      console.log(`[FAIL] ${name}: warm-up proof did not verify — witness builder is wrong, skipping timing`);
      continue;
    }

    const times = [];
    for (let i = 0; i < RUNS; i++) {
      const start = process.hrtime.bigint();
      await snarkjs.groth16.fullProve(witness, wasmPath, zkeyPath);
      const end = process.hrtime.bigint();
      times.push(Number(end - start) / 1e6);
    }

    const m = mean(times);
    const sd = stddev(times, m);
    console.log(`--- ${name} ---`);
    console.log(`  runs: ${RUNS}`);
    console.log(`  mean: ${m.toFixed(2)} ms   stddev: ${sd.toFixed(2)} ms   min: ${Math.min(...times).toFixed(2)} ms   max: ${Math.max(...times).toFixed(2)} ms`);
    results.push({ name, mean: m, stddev: sd });
  }

  console.log("\n=== Summary ===");
  for (const r of results) {
    console.log(`${r.name}: ${r.mean.toFixed(2)} ms (σ ${r.stddev.toFixed(2)})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
