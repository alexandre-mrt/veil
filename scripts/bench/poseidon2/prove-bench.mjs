#!/usr/bin/env node
/**
 * prove-bench.mjs — Groth16 proving-time comparison: production transfer.circom (circomlib
 * Poseidon) vs the transfer_poseidon2.circom fork (Poseidon2, domain tag in capacity), both
 * compiled with --O2 (full R1CS simplification) so the comparison isn't skewed by unswept
 * linear constraints (see the write-up for why O1-vs-O2 matters here).
 *
 * Usage: node scripts/bench/poseidon2/prove-bench.mjs [--runs N]
 * Prerequisite: build/transfer_orig_o2/ and build/transfer_poseidon2_o2/ populated by circom
 * (--O2, --wasm) and a Groth16 setup + dev contribution (see the write-up for exact commands).
 */
import { buildPoseidon } from "circomlibjs";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs as stringifyOrig } from "../witnesses.mjs";
import { buildTransferPoseidon2Witness, buildWithdrawPoseidon2Witness, stringifyInputs as stringifyP2 } from "./witness-transfer-poseidon2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "build");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) { return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }

async function bench(label, wasmPath, zkeyPath, inputs) {
  if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
    console.log(`[SKIP] ${label}: artifacts not found (${wasmPath})`);
    return null;
  }
  const times = [];
  const warm = await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
  const ok = await snarkjs.groth16.verify(
    JSON.parse((await import("fs")).readFileSync(zkeyPath.replace("_final.zkey", "_vk.json"), "utf8")),
    warm.publicSignals,
    warm.proof,
  );
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  const m = mean(times);
  const sd = stddev(times, m);
  console.log(`--- ${label} ---`);
  console.log(`  verify(warm-up proof): ${ok}`);
  console.log(`  runs: ${RUNS}`);
  console.log(`  mean: ${m.toFixed(2)} ms   stddev: ${sd.toFixed(2)} ms   min: ${Math.min(...times).toFixed(2)} ms   max: ${Math.max(...times).toFixed(2)} ms`);
  console.log("");
  return { label, meanMs: m, stddevMs: sd, minMs: Math.min(...times), maxMs: Math.max(...times), verified: ok };
}

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);

  console.log(`=== Veil Poseidon vs Poseidon2 Groth16 proving-time bench (${RUNS} runs each) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const origInputs = stringifyOrig(WITNESS_BUILDERS.transfer(poseidon));
  const p2Inputs = stringifyP2(buildTransferPoseidon2Witness());

  const results = [];
  results.push(await bench(
    "transfer.circom (circomlib Poseidon, --O2)",
    join(BUILD_DIR, "transfer_orig_o2", "transfer_js", "transfer.wasm"),
    join(BUILD_DIR, "transfer_orig_o2", "transfer_orig_o2_final.zkey"),
    origInputs,
  ));
  results.push(await bench(
    "transfer_poseidon2.circom (Poseidon2, --O2)",
    join(BUILD_DIR, "transfer_poseidon2_o2", "transfer_poseidon2_js", "transfer_poseidon2.wasm"),
    join(BUILD_DIR, "transfer_poseidon2_o2", "transfer_poseidon2_o2_final.zkey"),
    p2Inputs,
  ));

  const origWithdrawInputs = stringifyOrig(WITNESS_BUILDERS.withdraw(poseidon));
  const p2WithdrawInputs = stringifyP2(buildWithdrawPoseidon2Witness());

  results.push(await bench(
    "withdraw.circom (circomlib Poseidon, --O2)",
    join(BUILD_DIR, "withdraw_orig_o2", "withdraw_js", "withdraw.wasm"),
    join(BUILD_DIR, "withdraw_orig_o2", "withdraw_orig_o2_final.zkey"),
    origWithdrawInputs,
  ));
  results.push(await bench(
    "withdraw_poseidon2.circom (Poseidon2, --O2)",
    join(BUILD_DIR, "withdraw_poseidon2_o2", "withdraw_poseidon2_js", "withdraw_poseidon2.wasm"),
    join(BUILD_DIR, "withdraw_poseidon2_o2", "withdraw_poseidon2_o2_final.zkey"),
    p2WithdrawInputs,
  ));

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(results.filter(Boolean), null, 2));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
