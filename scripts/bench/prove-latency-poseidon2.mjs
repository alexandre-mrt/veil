#!/usr/bin/env node
/**
 * prove-latency-poseidon2.mjs — Node-side Groth16 proving-time benchmark for the
 * Poseidon2-hybrid transfer/compliance circuits (Merkle tree hashed with Poseidon2
 * compression, everything else unchanged — see
 * docs/research/2026-07-29-poseidon2-migration.md). Same methodology as
 * prove-latency.mjs, against circuits/build-hybrid/{transfer,compliance}/.
 *
 * Usage:
 *   node scripts/bench/prove-latency-poseidon2.mjs [--runs N]
 *
 * Prerequisite (produces the artifacts this script reads): see
 * docs/research/2026-07-29-poseidon2-migration.md, "Approach", for the exact compile +
 * setup commands.
 */
import { buildPoseidon } from "circomlibjs";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { WITNESS_BUILDERS_POSEIDON2, setPoseidonField, stringifyInputs } from "./witnesses-poseidon2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

const CIRCUITS = [
  { name: "transfer_hybrid", dir: "build-hybrid/transfer" },
  { name: "compliance_hybrid", dir: "build-hybrid/compliance" },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) {
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);

  console.log(`=== Veil Poseidon2-hybrid Groth16 proving-time benchmark (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const results = [];

  for (const circuit of CIRCUITS) {
    const wasmPath = join(CIRCUITS_DIR, circuit.dir, `${circuit.name}_js`, `${circuit.name}.wasm`);
    const zkeyPath = join(CIRCUITS_DIR, circuit.dir, `${circuit.name}_final.zkey`);
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      console.log(`[SKIP] ${circuit.name}: artifacts not found (${wasmPath})`);
      continue;
    }

    const inputs = stringifyInputs(WITNESS_BUILDERS_POSEIDON2[circuit.name](poseidon));
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

    console.log(`--- ${circuit.name} ---`);
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
