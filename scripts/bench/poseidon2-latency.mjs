#!/usr/bin/env node
/**
 * poseidon2-latency.mjs — Groth16 proving-time comparison between circomlib's
 * Poseidon(nInputs) and taceo's Poseidon2(t), at the widths that matter for
 * Veil's real circuits: nInputs=3 (t=4, a width Poseidon2 supports natively)
 * and nInputs=4 (t=5, which Poseidon2 does not support — padded to the next
 * supported width, t=8; this is Veil's dominant hash call, used 5 times
 * across transfer.circom and withdraw.circom for commitment/nullifier hashes).
 *
 * Usage:
 *   node scripts/bench/poseidon2-latency.mjs [--runs N]
 *
 * Prerequisite (produces the artifacts this script reads):
 *   bash circuits/bench/compile.sh
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

// BN254 scalar field order — inputs just need to be valid field elements;
// the circuit under test is Poseidon itself, so the values are arbitrary.
const FIELD_SAMPLE = [
  "1234567890123456789012345678901234567890",
  "9876543210987654321098765432109876543210",
  "18446744073709551615",
  "42",
  "20000000000000000000000000000000000000000000000000000000000000000",
];

const PAIRS = [
  {
    label: "nInputs=3 (t=4, Poseidon2 native width)",
    a: { name: "poseidon1_n3", nInputs: 3 },
    b: { name: "poseidon2_t4_n3", nInputs: 3 },
  },
  {
    label: "nInputs=4 (t=5 native / t=8 padded — Veil's dominant Poseidon(4) call)",
    a: { name: "poseidon1_n4", nInputs: 4 },
    b: { name: "poseidon2_t8_n4", nInputs: 4 },
  },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) {
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

async function bench(name, nInputs) {
  const wasmPath = join(BUILD_DIR, `${name}_js`, `${name}.wasm`);
  const zkeyPath = join(BUILD_DIR, `${name}_final.zkey`);
  if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
    console.log(`[SKIP] ${name}: artifacts not found — run circuits/bench/compile.sh first`);
    return null;
  }
  const inputs = { in: FIELD_SAMPLE.slice(0, nInputs) };

  // Warm-up (pays one-time WASM instantiation cost, not counted)
  await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);

  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6); // ms
  }
  const m = mean(times);
  const sd = stddev(times, m);
  return { name, runs: RUNS, meanMs: m, stddevMs: sd, minMs: Math.min(...times), maxMs: Math.max(...times) };
}

async function main() {
  console.log(`=== Poseidon vs Poseidon2 proving-time benchmark (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const results = [];
  for (const pair of PAIRS) {
    console.log(`--- ${pair.label} ---`);
    const ra = await bench(pair.a.name, pair.a.nInputs);
    const rb = await bench(pair.b.name, pair.b.nInputs);
    for (const r of [ra, rb]) {
      if (!r) continue;
      console.log(`  ${r.name}: mean ${r.meanMs.toFixed(2)} ms  stddev ${r.stddevMs.toFixed(2)} ms  min ${r.minMs.toFixed(2)} ms  max ${r.maxMs.toFixed(2)} ms`);
      results.push({ pair: pair.label, ...r });
    }
    if (ra && rb) {
      const deltaPct = ((rb.meanMs - ra.meanMs) / ra.meanMs) * 100;
      console.log(`  delta (${pair.b.name} vs ${pair.a.name}): ${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%`);
    }
    console.log("");
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
