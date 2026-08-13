#!/usr/bin/env node
/**
 * prove-latency.mjs — Groth16 proving-time benchmark for the p1_merkle20 /
 * p2_merkle20 micro-circuits (2026-08-13 Poseidon2 experiment).
 *
 * Same methodology as ../prove-latency.mjs: one warm-up fullProve (pays
 * one-time WASM instantiation, not counted), then RUNS timed repetitions
 * with process.hrtime.bigint().
 *
 * Usage: node prove-latency.mjs [--runs N]
 * Prerequisite: build/{p1,p2}_merkle20_js/*.wasm and build/{p1,p2}_merkle20_final.zkey
 * (produced by the circom + snarkjs setup commands in this experiment's report).
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "build");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

// Deterministic 20-level path: alternating left/right, arbitrary-but-fixed
// sibling values. Same witness shape fed to both circuits so any timing
// delta comes from the hash primitive, not the input.
function witness() {
  const pathElements = Array.from({ length: 20 }, (_, i) => (i + 1) * 7 + 1);
  const pathIndices = Array.from({ length: 20 }, (_, i) => i % 2);
  return { leaf: 12345, pathElements, pathIndices };
}

const CIRCUITS = [
  { name: "p1_merkle20 (circomlib Poseidon(2), 20x t=3)", dir: "p1_merkle20" },
  { name: "p2_merkle20 (Poseidon2 compression, 20x t=2)", dir: "p2_merkle20" },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) { return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }

async function main() {
  console.log(`=== Poseidon vs Poseidon2 Merkle-proof proving-time benchmark (${RUNS} runs) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const inputs = witness();
  const results = [];

  for (const c of CIRCUITS) {
    const wasmPath = join(BUILD_DIR, `${c.dir}_js`, `${c.dir}.wasm`);
    const zkeyPath = join(BUILD_DIR, `${c.dir}_final.zkey`);
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      console.log(`[SKIP] ${c.name}: artifacts not found`);
      continue;
    }

    const warm = await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
    const proofBytesJson = Buffer.byteLength(JSON.stringify(warm.proof));

    const times = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
      const t1 = process.hrtime.bigint();
      times.push(Number(t1 - t0) / 1e6);
    }

    const m = mean(times);
    const sd = stddev(times, m);
    results.push({ circuit: c.dir, meanMs: m, stddevMs: sd, minMs: Math.min(...times), maxMs: Math.max(...times), proofBytesJson });

    console.log(`--- ${c.name} ---`);
    console.log(`  runs: ${RUNS}`);
    console.log(`  mean: ${m.toFixed(2)} ms   stddev: ${sd.toFixed(2)} ms   min: ${Math.min(...times).toFixed(2)} ms   max: ${Math.max(...times).toFixed(2)} ms`);
    console.log("");
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));

  // snarkjs' bn128 curve keeps worker handles open after the last proof, which
  // otherwise leaves this process hanging indefinitely even though it's done
  // (same fix as circuits/test/*.test.mjs, PR #17).
  process.exit(0);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
