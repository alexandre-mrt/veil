#!/usr/bin/env node
/**
 * poseidon2-prove-latency.mjs — Node-side Groth16 proving-time benchmark for
 * Veil's three Poseidon2 shadow circuits (transfer2/withdraw2/compliance2),
 * mirroring prove-latency.mjs exactly so the two are directly comparable.
 *
 * Usage:
 *   node scripts/bench/poseidon2-prove-latency.mjs [--runs N]
 *
 * Prerequisite (produces the artifacts this script reads, from circuits/):
 *   node node_modules/circom2/cli.js transfer2.circom --r1cs --wasm --sym -o build2 -l node_modules
 *   node node_modules/circom2/cli.js withdraw2.circom --r1cs --wasm --sym -o build2 -l node_modules
 *   node node_modules/circom2/cli.js compliance2.circom --r1cs --wasm --sym -o build2 -l node_modules
 *   curl -L -o build2/pot15_final.ptau https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau
 *   # then snarkjs groth16 setup + zkey contribute + export verificationkey per circuit
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { WITNESS_BUILDERS_V2, stringifyInputs } from "./witnesses2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

const CIRCUITS = [
  { name: "transfer2", dir: "build2" },
  { name: "withdraw2", dir: "build2" },
  { name: "compliance2", dir: "build2" },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) {
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

async function main() {
  console.log(`=== Veil Poseidon2 shadow-circuit Groth16 proving-time benchmark (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const results = [];

  for (const circuit of CIRCUITS) {
    const wasmPath = join(CIRCUITS_DIR, circuit.dir, `${circuit.name}_js`, `${circuit.name}.wasm`);
    const zkeyPath = join(CIRCUITS_DIR, circuit.dir, `${circuit.name}_final.zkey`);
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      console.log(`[SKIP] ${circuit.name}: artifacts not found (${wasmPath})`);
      continue;
    }

    const inputs = stringifyInputs(WITNESS_BUILDERS_V2[circuit.name]());
    const times = [];

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
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
