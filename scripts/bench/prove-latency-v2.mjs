#!/usr/bin/env node
/**
 * prove-latency-v2.mjs — Node-side Groth16 proving-time benchmark for the Poseidon2-Merkle-hash
 * experiment circuits (transfer_v2, compliance_v2). Mirrors prove-latency.mjs exactly; only the
 * circuit set and witness builders differ (witnesses-v2.mjs, Poseidon2 Merkle path).
 *
 * Usage:
 *   node scripts/bench/prove-latency-v2.mjs [--runs N]
 *
 * Prerequisite (produces the artifacts this script reads):
 *   cd circuits
 *   circom transfer_v2.circom --r1cs --wasm --sym --output build_v2 -l node_modules
 *   circom compliance_v2.circom --r1cs --wasm --sym --output build_v2 -l node_modules
 *   cp build/pot15_final.ptau build_v2/   # reuse the same ptau as the baseline run
 *   # then snarkjs groth16 setup + zkey contribute + export verificationkey per circuit
 */
import { buildPoseidon } from "circomlibjs";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { WITNESS_BUILDERS_V2, stringifyInputs } from "./witnesses-v2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

const CIRCUITS = [
  { name: "transfer_v2", dir: "build_v2" },
  { name: "compliance_v2", dir: "build_v2" },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) {
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

async function main() {
  const poseidon = await buildPoseidon();

  console.log(`=== Veil Groth16 proving-time benchmark — Poseidon2 Merkle hash (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const results = [];

  for (const circuit of CIRCUITS) {
    const wasmPath = join(CIRCUITS_DIR, circuit.dir, `${circuit.name}_js`, `${circuit.name}.wasm`);
    const zkeyPath = join(CIRCUITS_DIR, circuit.dir, `${circuit.name}_final.zkey`);
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      console.log(`[SKIP] ${circuit.name}: artifacts not found (${wasmPath})`);
      continue;
    }

    const inputs = stringifyInputs(WITNESS_BUILDERS_V2[circuit.name](poseidon));
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

  // snarkjs' bn128 curve keeps worker handles open after the last proof — see
  // prove-latency.mjs / circuits/test PR #17 for the same fix on the test runners.
  process.exit(0);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
