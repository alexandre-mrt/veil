#!/usr/bin/env node
/**
 * poseidon2-delta.mjs — Constraint-count and proving-time delta between
 * circomlib's Poseidon and TACEO's Poseidon2 circom port, at the exact
 * arities Veil's circuits use.
 *
 * Shells out to the real `snarkjs r1cs info` CLI for constraint counts (the
 * same command circuits/scripts/compile.sh already runs and the 2026-07-22
 * baseline report cites — deliberately not a hand-rolled .r1cs parser) and
 * times snarkjs.groth16.fullProve the same way
 * scripts/bench/prove-latency.mjs does for the production circuits — mean of
 * N runs (default 10) after one uncounted warm-up run.
 *
 * Usage: node scripts/bench/poseidon2-delta.mjs [--runs N]
 * Prerequisite: bash circuits/scripts/compile-poseidon-bench.sh
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = join(__dirname, "..", "..", "circuits", "bench");
const BUILD_DIR = join(BENCH_DIR, "build");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

// Pairs: [poseidon circuit, matching poseidon2 circuit, note]
const PAIRS = [
  { poseidon: "poseidon_n2", poseidon2: "poseidon2_t3", nInputs: 2, t: 3, note: "direct match (t = nInputs+1)" },
  { poseidon: "poseidon_n3", poseidon2: "poseidon2_t4", nInputs: 3, t: 4, note: "direct match (t = nInputs+1)" },
  { poseidon: "poseidon_n4", poseidon2: "poseidon2_t8", nInputs: 4, t: 8, note: "rounded up — Poseidon2 has no t=5" },
  { poseidon: "poseidon_n5", poseidon2: "poseidon2_t8", nInputs: 5, t: 8, note: "rounded up — Poseidon2 has no t=6" },
];

/** Runs the real `snarkjs r1cs info` CLI and parses its stdout. */
function readR1csInfo(path) {
  const out = execFileSync("npx", ["snarkjs", "r1cs", "info", path], { encoding: "utf8" });
  const grab = (label) => {
    const m = out.match(new RegExp(`# of ${label}:\\s*(\\d+)`));
    if (!m) throw new Error(`could not parse "${label}" from snarkjs r1cs info output for ${path}:\n${out}`);
    return parseInt(m[1], 10);
  };
  return { nWires: grab("Wires"), nConstraints: grab("Constraints"), raw: out };
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) { return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }

async function timeCircuit(name, inputSignal, nElements) {
  const wasmPath = join(BUILD_DIR, `${name}_js`, `${name}.wasm`);
  const zkeyPath = join(BUILD_DIR, `${name}_final.zkey`);
  if (!existsSync(wasmPath) || !existsSync(zkeyPath)) return null;

  const input = { [inputSignal]: Array.from({ length: nElements }, (_, i) => String(i + 1)) };

  await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath); // warm-up, uncounted
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  const m = mean(times);
  return { meanMs: m, stddevMs: stddev(times, m), minMs: Math.min(...times), maxMs: Math.max(...times) };
}

async function main() {
  console.log(`=== Poseidon vs Poseidon2 primitive delta (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const rows = [];
  for (const pair of PAIRS) {
    const pPath = join(BUILD_DIR, `${pair.poseidon}.r1cs`);
    const p2Path = join(BUILD_DIR, `${pair.poseidon2}.r1cs`);
    if (!existsSync(pPath) || !existsSync(p2Path)) {
      console.log(`[SKIP] ${pair.poseidon} / ${pair.poseidon2}: r1cs not found — run circuits/scripts/compile-poseidon-bench.sh first`);
      continue;
    }
    const pHeader = readR1csInfo(pPath);
    const p2Header = readR1csInfo(p2Path);

    console.log(`--- Poseidon(${pair.nInputs}) [t=${pair.nInputs + 1}] vs Poseidon2(t=${pair.t}) — ${pair.note} ---`);
    console.log(`  Poseidon(${pair.nInputs})  : ${pHeader.nConstraints} constraints, ${pHeader.nWires} wires`);
    console.log(`  Poseidon2(${pair.t})  : ${p2Header.nConstraints} constraints, ${p2Header.nWires} wires`);
    const deltaPct = ((p2Header.nConstraints - pHeader.nConstraints) / pHeader.nConstraints) * 100;
    console.log(`  delta: ${p2Header.nConstraints - pHeader.nConstraints} constraints (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%)`);

    const pTime = await timeCircuit(pair.poseidon, "inputs", pair.nInputs);
    const p2Time = await timeCircuit(pair.poseidon2, "in", pair.t);
    if (pTime && p2Time) {
      console.log(`  Poseidon(${pair.nInputs}) proving time  : mean ${pTime.meanMs.toFixed(3)} ms (stddev ${pTime.stddevMs.toFixed(3)})`);
      console.log(`  Poseidon2(${pair.t}) proving time  : mean ${p2Time.meanMs.toFixed(3)} ms (stddev ${p2Time.stddevMs.toFixed(3)})`);
    }
    console.log("");

    rows.push({ ...pair, pConstraints: pHeader.nConstraints, p2Constraints: p2Header.nConstraints, pTime, p2Time });
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
