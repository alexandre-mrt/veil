#!/usr/bin/env node
// poseidon2-microbench.mjs — R1CS constraint count + Groth16 proving-time
// comparison: circomlib's current Poseidon vs. a from-spec Poseidon2, at the
// exact arities Veil actually uses (2-input Merkle sibling hash, 3-input
// txAmountHash/nfHash/ctxHash), plus a full depth-20 Merkle proof with each
// hash to project the effect on transfer.circom/compliance.circom directly.
//
// This does NOT touch any production circuit. It measures an isolated
// benchmark scaffold under circuits/bench/ to answer EXPERIMENTS.md item #2
// ("a measured constraint-count and proving-time delta from swapping to
// Poseidon2") before committing to an actual migration.
//
// Prerequisite: bash circuits/bench/compile-bench.sh
// Usage: node scripts/bench/poseidon2-microbench.mjs [--runs N]
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const BENCH_DIR = join(CIRCUITS_DIR, "bench", "build");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

const PAIRS = [
  {
    label: "2-input hash (Merkle sibling, used 20x/proof)",
    baseline: { name: "hash2_poseidon", inputs: { inputs: ["1", "2"] } },
    poseidon2: { name: "hash2_poseidon2", inputs: { inputs: ["1", "2"] } },
  },
  {
    label: "3-input hash (txAmountHash / compliance nfHash / ctxHash)",
    baseline: { name: "hash3_poseidon", inputs: { inputs: ["1", "2", "3"] } },
    poseidon2: { name: "hash3_poseidon2", inputs: { inputs: ["1", "2", "3"] } },
  },
  {
    label: "depth-20 Merkle proof (full anonymity-set membership check)",
    baseline: {
      name: "merkle20_poseidon",
      inputs: merkleInputs(),
    },
    poseidon2: {
      name: "merkle20_poseidon2",
      inputs: merkleInputs(),
    },
  },
];

function merkleInputs() {
  const pathElements = Array.from({ length: 20 }, (_, i) => String(i + 1));
  const pathIndices = Array.from({ length: 20 }, (_, i) => String(i % 2));
  return { leaf: "12345", pathElements, pathIndices };
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) { return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }

async function r1csInfo(name) {
  const r1csPath = join(BENCH_DIR, name, `${name}.r1cs`);
  // snarkjs.r1cs.info logs to console; capture via its return value instead
  // where available, else parse the printed summary.
  const info = await snarkjs.r1cs.info(r1csPath);
  return info;
}

async function proveLatency(name, inputs) {
  const wasmPath = join(BENCH_DIR, name, `${name}_js`, `${name}.wasm`);
  const zkeyPath = join(BENCH_DIR, name, `${name}_final.zkey`);
  if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
    return null;
  }
  // warm-up (pays one-time wasm instantiation cost)
  await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  const m = mean(times);
  return { meanMs: m, stddevMs: stddev(times, m), minMs: Math.min(...times), maxMs: Math.max(...times) };
}

async function main() {
  console.log(`=== Poseidon vs Poseidon2 microbenchmark (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const rows = [];
  for (const pair of PAIRS) {
    console.log(`--- ${pair.label} ---`);
    for (const variant of ["baseline", "poseidon2"]) {
      const { name, inputs } = pair[variant];
      const r1csPath = join(BENCH_DIR, name, `${name}.r1cs`);
      if (!existsSync(r1csPath)) {
        console.log(`[SKIP] ${name}: not compiled (run circuits/bench/compile-bench.sh)`);
        continue;
      }
      const info = await r1csInfo(name);
      const latency = await proveLatency(name, inputs);
      const row = {
        pair: pair.label,
        variant,
        name,
        nConstraints: info.nConstraints,
        nVars: info.nVars,
        nPubInputs: info.nPubInputs,
        nPrvInputs: info.nPrvInputs,
        ...latency,
      };
      rows.push(row);
      console.log(
        `  ${variant.padEnd(10)} ${name.padEnd(22)} constraints=${String(info.nConstraints).padStart(6)}` +
          (latency
            ? `  prove=${latency.meanMs.toFixed(2)}ms (sigma ${latency.stddevMs.toFixed(2)})`
            : "  [no zkey — proving not measured]")
      );
    }
    console.log("");
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(rows, null, 2));
}

main()
  .then(() => process.exit(0)) // snarkjs's wasm curve workers keep the event loop alive otherwise
  .catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
