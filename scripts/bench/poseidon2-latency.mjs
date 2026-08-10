#!/usr/bin/env node
/**
 * poseidon2-latency.mjs — Node-side Groth16 proving-time benchmark comparing
 * production Poseidon (circomlib) against Poseidon2 (@taceo/circom-lib) at
 * the three arities Veil's circuits actually use: the depth-20 Merkle-proof
 * sponge (t=3), the 3-input tx-amount-style hash (t=4), and the 4-input
 * commitment/nullifier-style hash (t=5, only available in Poseidon2 padded
 * to t=8).
 *
 * Reads compiled wasm/zkey artifacts from scripts/bench/circuits/build/,
 * produced by scripts/bench/circuits/build.sh.
 *
 * Usage:
 *   node scripts/bench/poseidon2-latency.mjs [--runs N]
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "circuits", "build");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

// p = BN254 scalar field modulus (same field circomlib/@taceo/circom-lib both use)
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function fieldElem(seed) {
  // Deterministic, distinct, in-range field elements — not cryptographically
  // random, but these circuits have no range/well-formedness constraints
  // beyond "is a field element", so any distinct values exercise the same
  // constraint set as real inputs would.
  return ((BigInt(seed) * 0x9e3779b97f4a7c15n + 12345n) % (P - 1n)) + 1n;
}

const CIRCUITS = [
  {
    name: "merkle_poseidon",
    label: "Merkle depth-20, Poseidon (t=3, production)",
    inputs: () => ({
      leaf: fieldElem(1).toString(),
      pathElements: Array.from({ length: 20 }, (_, i) => fieldElem(100 + i).toString()),
      pathIndices: Array.from({ length: 20 }, (_, i) => String(i % 2)),
    }),
  },
  {
    name: "merkle_poseidon2",
    label: "Merkle depth-20, Poseidon2 (t=3)",
    inputs: () => ({
      leaf: fieldElem(1).toString(),
      pathElements: Array.from({ length: 20 }, (_, i) => fieldElem(100 + i).toString()),
      pathIndices: Array.from({ length: 20 }, (_, i) => String(i % 2)),
    }),
  },
  {
    name: "hash_arity3_poseidon",
    label: "Arity-3 hash, Poseidon (t=4, production shape)",
    inputs: () => ({ in: [fieldElem(1), fieldElem(2), fieldElem(3)].map(String) }),
  },
  {
    name: "hash_arity3_poseidon2",
    label: "Arity-3 hash, Poseidon2 (t=4, native)",
    inputs: () => ({ in: [fieldElem(1), fieldElem(2), fieldElem(3)].map(String) }),
  },
  {
    name: "hash_arity4_poseidon",
    label: "Arity-4 hash, Poseidon (t=5, production shape)",
    inputs: () => ({ in: [fieldElem(1), fieldElem(2), fieldElem(3), fieldElem(4)].map(String) }),
  },
  {
    name: "hash_arity4_poseidon2_padded",
    label: "Arity-4 hash, Poseidon2 (t=8, zero-padded)",
    inputs: () => ({ in: [fieldElem(1), fieldElem(2), fieldElem(3), fieldElem(4)].map(String) }),
  },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) {
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

async function main() {
  console.log(`=== Veil Poseidon vs Poseidon2 proving-time benchmark (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const results = [];

  for (const circuit of CIRCUITS) {
    const wasmPath = join(BUILD_DIR, `${circuit.name}_js`, `${circuit.name}.wasm`);
    const zkeyPath = join(BUILD_DIR, `${circuit.name}_final.zkey`);
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      console.log(`[SKIP] ${circuit.name}: artifacts not found (${wasmPath})`);
      continue;
    }

    const inputs = circuit.inputs();
    const times = [];

    const warm = await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
    const proofBytesJson = Buffer.byteLength(JSON.stringify(warm.proof));

    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
      const t1 = process.hrtime.bigint();
      times.push(Number(t1 - t0) / 1e6);
    }

    const m = mean(times);
    const sd = stddev(times, m);
    results.push({ circuit: circuit.name, label: circuit.label, runs: RUNS, meanMs: m, stddevMs: sd, minMs: Math.min(...times), maxMs: Math.max(...times), proofBytesJson });

    console.log(`--- ${circuit.name} (${circuit.label}) ---`);
    console.log(`  runs: ${RUNS}`);
    console.log(`  mean: ${m.toFixed(2)} ms   stddev: ${sd.toFixed(2)} ms   min: ${Math.min(...times).toFixed(2)} ms   max: ${Math.max(...times).toFixed(2)} ms`);
    console.log("");
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
