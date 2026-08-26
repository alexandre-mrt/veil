#!/usr/bin/env node
/**
 * poseidon2-arity-bench.mjs — constraint-count and Groth16 proving-time comparison
 * between circomlib's Poseidon(n) (what Veil's production circuits call today) and
 * @taceo/circom-lib's Poseidon2Sponge(n, t), at n = 2, 3, 4, 5 — the exact arities used
 * by transfer.circom, withdraw.circom, compliance.circom, and templates/merkle_proof.circom.
 *
 * Prerequisite: scripts/bench/compile-poseidon2-bench.sh (compiles the 8 circuits under
 * circuits/bench-poseidon2/ and runs a throwaway Groth16 setup for each).
 *
 * Usage:
 *   node scripts/bench/compile-poseidon2-bench.sh
 *   node scripts/bench/poseidon2-arity-bench.mjs [--runs N]
 */
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const BUILD_DIR = join(CIRCUITS_DIR, "bench-poseidon2", "build");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

// n -> Poseidon2 state size t used (smallest of {2,3,4,8,12,16} with rate t-1 >= n)
const ARITIES = [
  { n: 2, t: 3 },
  { n: 3, t: 4 },
  { n: 4, t: 8 },
  { n: 5, t: 8 },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) { return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }

function r1csInfo(name) {
  const r1csPath = join(BUILD_DIR, `${name}.r1cs`);
  const out = execSync(`npx snarkjs r1cs info ${JSON.stringify(r1csPath)}`, { cwd: CIRCUITS_DIR }).toString();
  const num = (label) => {
    const m = out.match(new RegExp(`# of ${label}:\\s*(\\d+)`));
    return m ? parseInt(m[1], 10) : null;
  };
  return {
    wires: num("Wires"),
    constraints: num("Constraints"),
    privateInputs: num("Private Inputs"),
    publicInputs: num("Public Inputs"),
    raw: out.trim(),
  };
}

async function timeProving(name, n) {
  const wasmPath = join(BUILD_DIR, `${name}_js`, `${name}.wasm`);
  const zkeyPath = join(BUILD_DIR, `${name}_final.zkey`);
  if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
    console.log(`[SKIP] ${name}: artifacts not found — run compile-poseidon2-bench.sh first`);
    return null;
  }
  const input = { in: Array.from({ length: n }, (_, i) => i + 1) };

  const warm = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  void warm;

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
  console.log(`=== Poseidon vs Poseidon2 arity bench (${RUNS} proving runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const rows = [];
  for (const { n, t } of ARITIES) {
    const poseidonName = `poseidon_n${n}`;
    const poseidon2Name = `poseidon2_n${n}`;

    const poseidonInfo = r1csInfo(poseidonName);
    const poseidon2Info = r1csInfo(poseidon2Name);
    console.log(`--- n=${n} (Poseidon2 t=${t}) ---`);
    console.log(`Poseidon(${n}):  ${poseidonInfo.raw.split("\n").join(" | ")}`);
    console.log(`Poseidon2Sponge(${n},${t}): ${poseidon2Info.raw.split("\n").join(" | ")}`);

    const poseidonTime = await timeProving(poseidonName, n);
    const poseidon2Time = await timeProving(poseidon2Name, n);
    if (poseidonTime) console.log(`Poseidon(${n}) proving:  mean ${poseidonTime.meanMs.toFixed(3)} ms  stddev ${poseidonTime.stddevMs.toFixed(3)} ms`);
    if (poseidon2Time) console.log(`Poseidon2(${n}) proving: mean ${poseidon2Time.meanMs.toFixed(3)} ms  stddev ${poseidon2Time.stddevMs.toFixed(3)} ms`);
    console.log("");

    rows.push({ n, t, poseidonInfo, poseidon2Info, poseidonTime, poseidon2Time });
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
