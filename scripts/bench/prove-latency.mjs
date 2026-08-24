#!/usr/bin/env node
/**
 * prove-latency.mjs — Node-side Groth16 proving-time benchmark for Veil's three circuits.
 *
 * Measures wall-clock time for snarkjs groth16.fullProve (witness generation + proving)
 * against the compiled wasm/zkey artifacts in circuits/build{,-withdraw,-compliance}/.
 *
 * Usage:
 *   node scripts/bench/prove-latency.mjs [--runs N]
 *
 * Prerequisite (produces the artifacts this script reads):
 *   cd circuits
 *   circom transfer.circom --r1cs --wasm --sym --output build -l node_modules
 *   circom withdraw.circom --r1cs --wasm --sym --output build-withdraw -l node_modules
 *   circom compliance.circom --r1cs --wasm --sym --output build-compliance -l node_modules
 *   curl -L -o build/pot15_final.ptau https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau
 *   # then snarkjs groth16 setup + zkey contribute + export verificationkey per circuit
 *   # (see circuits/scripts/compile*.sh for the exact sequence)
 */
import { buildPoseidon } from "circomlibjs";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "./witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

const CIRCUITS = [
  { name: "transfer", dir: "build" },
  { name: "withdraw", dir: "build-withdraw" },
  { name: "compliance", dir: "build-compliance" },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) {
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);

  console.log(`=== Veil Groth16 proving-time benchmark (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const results = [];

  for (const circuit of CIRCUITS) {
    const wasmPath = join(CIRCUITS_DIR, circuit.dir, `${circuit.name}_js`, `${circuit.name}.wasm`);
    const zkeyPath = join(CIRCUITS_DIR, circuit.dir, `${circuit.name}_final.zkey`);
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      console.log(`[SKIP] ${circuit.name}: artifacts not found (${wasmPath})`);
      continue;
    }

    const inputs = stringifyInputs(WITNESS_BUILDERS[circuit.name](poseidon));
    const times = [];

    // Warm-up run (not counted — first call pays WASM instantiation cost)
    const warm = await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
    const proofBytesJson = Buffer.byteLength(JSON.stringify(warm.proof));
    const publicSignalsCount = warm.publicSignals.length;

    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
      const t1 = process.hrtime.bigint();
      times.push(Number(t1 - t0) / 1e6); // ms
    }

    const m = mean(times);
    const sd = stddev(times, m);
    results.push({
      circuit: circuit.name, runs: RUNS, meanMs: m, stddevMs: sd,
      minMs: Math.min(...times), maxMs: Math.max(...times),
      proofBytesJson, publicSignalsCount,
    });

    console.log(`--- ${circuit.name} ---`);
    console.log(`  runs: ${RUNS}`);
    console.log(`  mean: ${m.toFixed(2)} ms   stddev: ${sd.toFixed(2)} ms   min: ${Math.min(...times).toFixed(2)} ms   max: ${Math.max(...times).toFixed(2)} ms`);
    console.log(`  proof JSON size: ${proofBytesJson} bytes, public signals: ${publicSignalsCount}`);
    console.log("");
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));

  // snarkjs' bn128 curve keeps worker handles open after the last proof
  // (see circuits/test/*.test.mjs), which otherwise leaves this process
  // hanging indefinitely even though every benchmark above completed.
  process.exit(0);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
