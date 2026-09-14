#!/usr/bin/env node
/**
 * component-witness-latency.mjs — witness-generation wall-clock time for isolated
 * gadgets (circuits/bench/components/), to translate the constraint-count
 * decomposition from component-constraints.sh into a real per-gadget time budget.
 *
 * Only measures witness generation (WASM), not full Groth16 proving — these
 * isolated gadgets have no zkey (no per-gadget trusted setup was run; that's out
 * of scope for a component-level micro-benchmark). Compare the ratio between
 * gadgets, and against scripts/bench/prove-latency.mjs's full-circuit numbers,
 * not the absolute values.
 *
 * Usage:
 *   node scripts/bench/component-witness-latency.mjs [--runs N]
 *
 * Prerequisite (produces the wasm this script reads):
 *   cd circuits/bench/components
 *   circom poseidon2.circom --wasm -o build -l ../../node_modules
 *   circom merkle20.circom --wasm -o build -l ../../node_modules
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPONENTS_DIR = join(__dirname, "..", "..", "circuits", "bench", "components");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 20;
})();

const GADGETS = [
  {
    name: "poseidon2 (1x arity-2 hash)",
    dir: "poseidon2",
    input: { a: "1", b: "2" },
  },
  {
    name: "merkle20 (20x arity-2 hash + 20x mux)",
    dir: "merkle20",
    input: {
      leaf: "1",
      pathElements: Array.from({ length: 20 }, (_, i) => String(i + 2)),
      pathIndices: Array.from({ length: 20 }, () => "0"),
    },
  },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) {
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

async function main() {
  console.log(`=== Veil component witness-generation benchmark (${RUNS} runs) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const results = [];

  for (const gadget of GADGETS) {
    const wasmPath = join(COMPONENTS_DIR, "build", `${gadget.dir}_js`, `${gadget.dir}.wasm`);
    if (!existsSync(wasmPath)) {
      console.log(`[SKIP] ${gadget.name}: ${wasmPath} not found`);
      continue;
    }

    // Warm-up (pays WASM instantiation cost once, not counted)
    await snarkjs.wtns.calculate(gadget.input, wasmPath, "/tmp/_warm.wtns");

    const times = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      await snarkjs.wtns.calculate(gadget.input, wasmPath, `/tmp/_bench_${gadget.dir}.wtns`);
      const t1 = process.hrtime.bigint();
      times.push(Number(t1 - t0) / 1e6); // ms
    }

    const m = mean(times);
    const sd = stddev(times, m);
    results.push({ gadget: gadget.name, runs: RUNS, meanMs: m, stddevMs: sd });
    console.log(`--- ${gadget.name} ---`);
    console.log(`  mean: ${m.toFixed(3)} ms   stddev: ${sd.toFixed(3)} ms   min: ${Math.min(...times).toFixed(3)} ms   max: ${Math.max(...times).toFixed(3)} ms`);
    console.log("");
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
