#!/usr/bin/env node
// Full-circuit Groth16 proving-time comparison: withdraw.circom (circomlib
// Poseidon) vs withdraw_poseidon2.circom (taceo Poseidon2, t=8 padded for the
// three 4-input hashes, t=3 native for recipientHash). Same witness values,
// same C1-C9 constraint structure, only the hash primitive differs.
//
// Usage: node circuits/bench/withdraw_compare.mjs [--runs N]
// Prerequisite:
//   circom withdraw.circom --r1cs --wasm --sym --output bench/build-withdraw-compare -l node_modules
//   circom bench/withdraw_poseidon2.circom --r1cs --wasm --sym --output bench/build-withdraw-compare -l node_modules
//   (+ groth16 setup/contribute/export against pot13_final.ptau — see compile.sh style)
import { buildPoseidon } from "circomlibjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { poseidon2 } from "./compute_poseidon2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, "build-withdraw-compare");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

function toBI(x) {
  return typeof x === "bigint" ? x : BigInt(x);
}

async function buildOriginalWitness() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xABCDEF123456n, randomnessNew = 77777n;
  const commitment = toBI(F.toObject(poseidon([1n, cumulativeOld, randomnessOld, userSecret])));
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = toBI(F.toObject(poseidon([1n, remainingBalance, randomnessNew, userSecret])));
  const nullifier = toBI(F.toObject(poseidon([7n, userSecret, randomnessOld, cumulativeOld])));
  const recipientHash = toBI(F.toObject(poseidon([8n, recipient])));
  return { commitment, withdrawAmount, nullifier, recipientHash, newCommitment,
    cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew };
}

async function buildPoseidon2Witness() {
  const cumulativeOld = 500n, randomnessOld = 12345n, userSecret = 987654321n;
  const withdrawAmount = 100n, recipient = 0xABCDEF123456n, randomnessNew = 77777n;
  const commitment = await poseidon2("poseidon2_t8_n4", [1n, cumulativeOld, randomnessOld, userSecret]);
  const remainingBalance = cumulativeOld - withdrawAmount;
  const newCommitment = await poseidon2("poseidon2_t8_n4", [1n, remainingBalance, randomnessNew, userSecret]);
  const nullifier = await poseidon2("poseidon2_t8_n4", [7n, userSecret, randomnessOld, cumulativeOld]);
  const recipientHash = await poseidon2("poseidon2_t3_n2", [8n, recipient]);
  return { commitment, withdrawAmount, nullifier, recipientHash, newCommitment,
    cumulativeOld, randomnessOld, userSecret, recipient, randomnessNew };
}

function stringify(inputs) {
  const out = {};
  for (const [k, v] of Object.entries(inputs)) out[k] = v.toString();
  return out;
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) { return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }

async function bench(name, inputs) {
  const wasmPath = join(DIR, `${name}_js`, `${name}.wasm`);
  const zkeyPath = join(DIR, `${name}_final.zkey`);
  const strInputs = stringify(inputs);

  const warm = await snarkjs.groth16.fullProve(strInputs, wasmPath, zkeyPath);
  const proofBytesJson = Buffer.byteLength(JSON.stringify(warm.proof));

  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    await snarkjs.groth16.fullProve(strInputs, wasmPath, zkeyPath);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  const m = mean(times);
  return { name, runs: RUNS, meanMs: m, stddevMs: stddev(times, m), minMs: Math.min(...times), maxMs: Math.max(...times), proofBytesJson };
}

async function main() {
  console.log(`=== withdraw.circom vs withdraw_poseidon2.circom — full-circuit Groth16 proving time (${RUNS} runs) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const origWitness = await buildOriginalWitness();
  const p2Witness = await buildPoseidon2Witness();

  const r1 = await bench("withdraw", origWitness);
  console.log(`withdraw (Poseidon):    mean ${r1.meanMs.toFixed(2)} ms  stddev ${r1.stddevMs.toFixed(2)} ms  min ${r1.minMs.toFixed(2)} ms  max ${r1.maxMs.toFixed(2)} ms  proof ${r1.proofBytesJson}B`);

  const r2 = await bench("withdraw_poseidon2", p2Witness);
  console.log(`withdraw_poseidon2:     mean ${r2.meanMs.toFixed(2)} ms  stddev ${r2.stddevMs.toFixed(2)} ms  min ${r2.minMs.toFixed(2)} ms  max ${r2.maxMs.toFixed(2)} ms  proof ${r2.proofBytesJson}B`);

  const deltaPct = ((r2.meanMs - r1.meanMs) / r1.meanMs) * 100;
  console.log(`\ndelta (withdraw_poseidon2 vs withdraw): ${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%`);

  console.log("\n=== Summary (JSON) ===");
  console.log(JSON.stringify([r1, r2], null, 2));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
