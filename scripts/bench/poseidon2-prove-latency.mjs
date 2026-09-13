#!/usr/bin/env node
/**
 * poseidon2-prove-latency.mjs — Node-side Groth16 proving-time benchmark comparing circomlib's
 * Poseidon against @taceo/circom-lib's Poseidon2, at the two arities Veil actually uses
 * (2 inputs / t=3, 3 inputs / t=4). Same fullProve-timing methodology as
 * scripts/bench/prove-latency.mjs (warm-up run not counted, then N timed repetitions).
 *
 * Invoked by scripts/bench/poseidon2-constraints.sh after it compiles the four circuits under
 * circuits/bench/poseidon2/ and runs the dev-only Groth16 setup — not meant to be run standalone
 * unless those build artifacts already exist.
 */
import { buildPoseidon } from "circomlibjs";
import { bn254 } from "@taceo/poseidon2";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = join(__dirname, "..", "..", "circuits", "bench", "poseidon2");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

// Two private inputs, fixed across circuits so the *only* thing that varies is the hash function.
const INPUTS_2 = [111n, 222n];
const INPUTS_3 = [111n, 222n, 333n];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) { return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }

function poseidon2Hash(t, ins) {
  const state = [0n, ...ins];
  const out = bn254[`t${t}`].permutation(state);
  return out[0];
}

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const toBI = (v) => (typeof v === "bigint" ? v : F.toObject(v));

  const CIRCUITS = [
    {
      name: "main_poseidon_t3",
      inputs: INPUTS_2,
      expectedHash: toBI(poseidon(INPUTS_2)),
    },
    {
      name: "main_poseidon2_t3",
      inputs: INPUTS_2,
      expectedHash: poseidon2Hash(3, INPUTS_2),
    },
    {
      name: "main_poseidon_t4",
      inputs: INPUTS_3,
      expectedHash: toBI(poseidon(INPUTS_3)),
    },
    {
      name: "main_poseidon2_t4",
      inputs: INPUTS_3,
      expectedHash: poseidon2Hash(4, INPUTS_3),
    },
  ];

  console.log(`=== Poseidon vs Poseidon2 proving-time benchmark (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const results = [];
  for (const c of CIRCUITS) {
    const wasmPath = join(BENCH_DIR, "build", `${c.name}_js`, `${c.name}.wasm`);
    const zkeyPath = join(BENCH_DIR, "build", `${c.name}_final.zkey`);
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      console.log(`[SKIP] ${c.name}: artifacts not found (${wasmPath})`);
      continue;
    }

    const inputs = {
      in: c.inputs.map((x) => x.toString()),
      expectedHash: c.expectedHash.toString(),
    };

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
    results.push({ circuit: c.name, runs: RUNS, meanMs: m, stddevMs: sd, minMs: Math.min(...times), maxMs: Math.max(...times), proofBytesJson });

    console.log(`--- ${c.name} ---`);
    console.log(`  runs: ${RUNS}`);
    console.log(`  mean: ${m.toFixed(3)} ms   stddev: ${sd.toFixed(3)} ms   min: ${Math.min(...times).toFixed(3)} ms   max: ${Math.max(...times).toFixed(3)} ms`);
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
