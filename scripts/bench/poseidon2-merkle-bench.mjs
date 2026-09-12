#!/usr/bin/env node
/**
 * poseidon2-merkle-bench.mjs — Node-side Groth16 proving-time A/B benchmark:
 * circomlib's Poseidon(2) Merkle hasher (control) vs Poseidon2Hash2 (experimental),
 * for transfer.circom and compliance.circom.
 *
 * Same methodology as scripts/bench/prove-latency.mjs (warm-up run not counted, then N
 * timed snarkjs.groth16.fullProve calls via process.hrtime.bigint()) so the numbers are
 * directly comparable to docs/research/BASELINE.md.
 *
 * Prerequisite (produces the artifacts this script reads — all local, no network):
 *   cd circuits
 *   circom transfer.circom --r1cs --wasm -o build/experiments -l node_modules
 *   mv build/experiments/transfer.r1cs build/experiments/transfer_control.r1cs
 *   mv build/experiments/transfer_js build/experiments/transfer_control_js
 *   circom experiments/transfer_poseidon2_merkle.circom --r1cs --wasm -o build/experiments -l node_modules
 *   circom compliance.circom --r1cs --wasm -o build/experiments -l node_modules
 *   mv build/experiments/compliance.r1cs build/experiments/compliance_control.r1cs
 *   mv build/experiments/compliance_js build/experiments/compliance_control_js
 *   circom experiments/compliance_poseidon2_merkle.circom --r1cs --wasm -o build/experiments -l node_modules
 *   cd build/experiments
 *   npx snarkjs powersoftau new bn128 15 pot15_0000.ptau      # fresh LOCAL ceremony —
 *   npx snarkjs powersoftau contribute pot15_0000.ptau pot15_0001.ptau --name="..." -e="..."
 *   npx snarkjs powersoftau prepare phase2 pot15_0001.ptau pot15_final.ptau
 *   # (no network access to the canonical Hermez ptau in this sandbox — see the research
 *   #  report. A fresh local ptau is valid for this A/B comparison: phase 1 is circuit-
 *   #  independent, and the SAME ptau is used for both the control and experimental zkeys.)
 *   for c in transfer_control transfer_poseidon2_merkle compliance_control compliance_poseidon2_merkle; do
 *     npx snarkjs groth16 setup $c.r1cs pot15_final.ptau ${c}_0000.zkey
 *     npx snarkjs zkey contribute ${c}_0000.zkey ${c}_final.zkey --name="veil research dev" -e="..."
 *   done
 *
 * Usage: node scripts/bench/poseidon2-merkle-bench.mjs [--runs N]
 */
import { buildPoseidon } from "circomlibjs";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { WITNESS_BUILDERS as CONTROL_BUILDERS, setPoseidonField, stringifyInputs } from "./witnesses.mjs";
import { WITNESS_BUILDERS as EXPERIMENT_BUILDERS } from "./witnesses-poseidon2-merkle.mjs";
import { makePoseidon2 } from "./poseidon2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXP_DIR = join(__dirname, "..", "..", "circuits", "build", "experiments");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

const PAIRS = [
  { label: "transfer", control: "transfer_control", experiment: "transfer_poseidon2_merkle", key: "transfer" },
  { label: "compliance", control: "compliance_control", experiment: "compliance_poseidon2_merkle", key: "compliance" },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) { return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }

async function timeCircuit(name, builderFn, poseidon, compress) {
  const wasmPath = join(EXP_DIR, `${name}_js`, `${name}.wasm`);
  const zkeyPath = join(EXP_DIR, `${name}_final.zkey`);
  if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
    return { name, skipped: true, reason: `artifacts not found (${wasmPath})` };
  }

  const rawInputs = compress ? builderFn(poseidon, compress) : builderFn(poseidon);
  const inputs = stringifyInputs(rawInputs);
  const times = [];

  const warm = await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
  const vkeyPath = join(EXP_DIR, `${name}_vk.json`);
  let verifyOk = null;
  if (existsSync(vkeyPath)) {
    const vkey = JSON.parse(await (await import("fs/promises")).readFile(vkeyPath, "utf8"));
    verifyOk = await snarkjs.groth16.verify(vkey, warm.publicSignals, warm.proof);
  }

  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }

  const m = mean(times);
  const sd = stddev(times, m);
  return { name, runs: RUNS, meanMs: m, stddevMs: sd, minMs: Math.min(...times), maxMs: Math.max(...times), verifyOk };
}

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  const { compress } = await makePoseidon2();

  console.log(`=== Poseidon2 Merkle-hasher proving-time A/B (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const results = [];
  for (const pair of PAIRS) {
    const control = await timeCircuit(pair.control, CONTROL_BUILDERS[pair.key], poseidon, null);
    const experiment = await timeCircuit(pair.experiment, EXPERIMENT_BUILDERS[pair.experiment], poseidon, compress);
    results.push({ pair: pair.label, control, experiment });

    console.log(`--- ${pair.label} ---`);
    for (const r of [control, experiment]) {
      if (r.skipped) { console.log(`  [SKIP] ${r.name}: ${r.reason}`); continue; }
      console.log(`  ${r.name}: mean ${r.meanMs.toFixed(2)} ms  stddev ${r.stddevMs.toFixed(2)} ms  min ${r.minMs.toFixed(2)} ms  max ${r.maxMs.toFixed(2)} ms  verify=${r.verifyOk}`);
    }
    if (!control.skipped && !experiment.skipped) {
      const delta = experiment.meanMs - control.meanMs;
      console.log(`  delta (experiment - control): ${delta.toFixed(2)} ms (${((delta / control.meanMs) * 100).toFixed(2)}%)`);
    }
    console.log("");
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));
  // snarkjs' bn128 curve keeps worker handles open after the last proof (same symptom
  // documented in circuits/test/transfer.test.mjs and the 2026-07-22 baseline report) —
  // exit explicitly instead of hanging.
  process.exit(0);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
