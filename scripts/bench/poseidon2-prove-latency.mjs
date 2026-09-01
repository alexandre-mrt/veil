#!/usr/bin/env node
/**
 * poseidon2-prove-latency.mjs — Node-side Groth16 proving-time benchmark for the
 * EXPERIMENTAL Poseidon2-swapped circuit variants in circuits/poseidon2-experiment/.
 *
 * Mirrors prove-latency.mjs exactly (same warm-up-then-N-runs methodology, same
 * witness shapes via witnesses.mjs) but hashes with poseidon2-hash.mjs instead of
 * circomlibjs's original Poseidon, and points at circuits/poseidon2-experiment/build/
 * instead of circuits/build{,-withdraw,-compliance}/.
 *
 * Usage:
 *   node scripts/bench/poseidon2-prove-latency.mjs [--runs N]
 *
 * Prerequisite (produces the artifacts this script reads):
 *   cd circuits/poseidon2-experiment && npm install
 *   bash compile-p2.sh   # circom (built from iden3/circom v2.2.2) + snarkjs groth16 setup
 *   # see circuits/poseidon2-experiment/README.md
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { poseidon2 } from "./poseidon2-hash.mjs";
import { WITNESS_BUILDERS, stringifyInputs } from "./witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const P2_DIR = join(__dirname, "..", "..", "circuits", "poseidon2-experiment", "build");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

const CIRCUITS = [
  { name: "transfer", file: "transfer_p2" },
  { name: "withdraw", file: "withdraw_p2" },
  { name: "compliance", file: "compliance_p2" },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) {
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

async function main() {
  console.log(`=== Veil Poseidon2-experiment Groth16 proving-time benchmark (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const results = [];

  for (const circuit of CIRCUITS) {
    const wasmPath = join(P2_DIR, `${circuit.file}_js`, `${circuit.file}.wasm`);
    const zkeyPath = join(P2_DIR, `${circuit.file}_final.zkey`);
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      console.log(`[SKIP] ${circuit.name}: artifacts not found (${wasmPath})`);
      continue;
    }

    const inputs = stringifyInputs(WITNESS_BUILDERS[circuit.name](poseidon2));
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
      circuit: circuit.name, runs: RUNS, meanMs: m, stddevMs: sd,
      minMs: Math.min(...times), maxMs: Math.max(...times),
      proofBytesJson, publicSignalsCount,
    });

    console.log(`--- ${circuit.name} (poseidon2 experimental) ---`);
    console.log(`  runs: ${RUNS}`);
    console.log(`  mean: ${m.toFixed(2)} ms   stddev: ${sd.toFixed(2)} ms   min: ${Math.min(...times).toFixed(2)} ms   max: ${Math.max(...times).toFixed(2)} ms`);
    console.log(`  proof JSON size: ${proofBytesJson} bytes, public signals: ${publicSignalsCount}`);
    console.log("");
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
