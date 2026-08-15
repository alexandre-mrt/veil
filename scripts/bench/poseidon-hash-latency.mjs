#!/usr/bin/env node
/**
 * poseidon-hash-latency.mjs — Node-side Groth16 proving-time benchmark comparing
 * circomlib's Poseidon(nInputs) against @taceo/circom-lib's Poseidon2(t) permutation
 * (wrapped in a sponge with the same [0, ...inputs] shape) at every hash arity Veil's
 * production circuits actually use (nInputs = 2, 3, 4, 5).
 *
 * Prerequisite (produces the artifacts this script reads):
 *   bash circuits/bench/compile.sh
 *
 * Usage:
 *   node scripts/bench/poseidon-hash-latency.mjs [--runs N]
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "..", "..", "circuits", "bench", "build");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

const ARITIES = [2, 3, 4, 5];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) {
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

function randomField() {
  // small-ish random values are fine: these circuits only exercise the hash, not
  // any range check, so any BN254-scalar-sized value is a valid witness.
  return (BigInt(Math.floor(Math.random() * 0xffffffff)) << 32n) | BigInt(Math.floor(Math.random() * 0xffffffff));
}

async function timeCircuit(name, nInputs) {
  const wasmPath = join(BUILD_DIR, `${name}_js`, `${name}.wasm`);
  const zkeyPath = join(BUILD_DIR, `${name}_final.zkey`);
  if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
    console.log(`[SKIP] ${name}: artifacts not found (run bash circuits/bench/compile.sh)`);
    return null;
  }

  const inputs = { inputs: Array.from({ length: nInputs }, () => randomField().toString()) };

  // warm-up (pays one-time WASM instantiation, not counted)
  await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);

  const times = [];
  let proofSize = 0;
  for (let i = 0; i < RUNS; i++) {
    const start = process.hrtime.bigint();
    const { proof } = await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
    const end = process.hrtime.bigint();
    times.push(Number(end - start) / 1e6);
    proofSize = JSON.stringify(proof).length;
  }

  const m = mean(times);
  const sd = stddev(times, m);
  console.log(`--- ${name} ---`);
  console.log(`  runs: ${RUNS}`);
  console.log(`  mean: ${m.toFixed(2)} ms   stddev: ${sd.toFixed(2)} ms   min: ${Math.min(...times).toFixed(2)} ms   max: ${Math.max(...times).toFixed(2)} ms`);
  console.log(`  proof JSON size: ${proofSize} bytes`);
  return { name, mean: m, stddev: sd };
}

async function main() {
  console.log(`=== Poseidon vs Poseidon2 proving-time benchmark (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  for (const n of ARITIES) {
    await timeCircuit(`poseidon1_n${n}`, n);
    await timeCircuit(`poseidon2_n${n}`, n);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
