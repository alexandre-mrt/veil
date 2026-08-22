#!/usr/bin/env node
/**
 * optimization-latency.mjs — Node-side Groth16 proving-time benchmark comparing
 * circom optimization levels (--O1 default vs --O2 full simplification) and,
 * for the same --O2 level, the original Poseidon hash vs the experimental
 * Poseidon2 hash swap (circuits/experiments/poseidon2/).
 *
 * Written for docs/research/2026-08-22-poseidon2-hash-swap.md — see that report
 * for what each variant is and why it exists.
 *
 * Usage:
 *   node scripts/bench/optimization-latency.mjs [--runs N]
 *
 * Prerequisite (produces the artifacts this script reads — see
 * circuits/scripts/setup-variant.sh, used to build all of these):
 *   circuits/build-o1/{transfer,compliance,withdraw}/          (circom --O1, default)
 *   circuits/build-o2/{transfer,compliance,withdraw}/          (circom --O2)
 *   circuits/build-poseidon2-o2/{transfer,compliance,withdraw}/ (circom --O2, Poseidon2 swap)
 */
import { buildPoseidon } from "circomlibjs";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "./witnesses.mjs";
import { POSEIDON2_WITNESS_BUILDERS, setPoseidonField as setPoseidonField2 } from "./poseidon2-witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

// { label, dir, wasmName, zkeyName, witnessKind, poseidon2 }
const VARIANTS = [
  { label: "transfer   O1 (default, current)", dir: "build-o1/transfer", wasmName: "transfer", zkeyName: "transfer_final", kind: "transfer" },
  { label: "transfer   O2 (full simplification)", dir: "build-o2/transfer", wasmName: "transfer", zkeyName: "transfer_final", kind: "transfer" },
  { label: "transfer   O2 + Poseidon2 swap", dir: "build-poseidon2-o2/transfer", wasmName: "transfer_poseidon2", zkeyName: "transfer_poseidon2_final", kind: "transfer", poseidon2: true },
  { label: "compliance O1 (default, current)", dir: "build-o1/compliance", wasmName: "compliance", zkeyName: "compliance_final", kind: "compliance" },
  { label: "compliance O2 (full simplification)", dir: "build-o2/compliance", wasmName: "compliance", zkeyName: "compliance_final", kind: "compliance" },
  { label: "compliance O2 + Poseidon2 swap", dir: "build-poseidon2-o2/compliance", wasmName: "compliance_poseidon2", zkeyName: "compliance_poseidon2_final", kind: "compliance", poseidon2: true },
  { label: "withdraw   O1 (default, current)", dir: "build-o1/withdraw", wasmName: "withdraw", zkeyName: "withdraw_final", kind: "withdraw" },
  { label: "withdraw   O2 (full simplification)", dir: "build-o2/withdraw", wasmName: "withdraw", zkeyName: "withdraw_final", kind: "withdraw" },
  { label: "withdraw   O2 + Poseidon2 swap", dir: "build-poseidon2-o2/withdraw", wasmName: "withdraw_poseidon2", zkeyName: "withdraw_poseidon2_final", kind: "withdraw", poseidon2: true },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) { return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  setPoseidonField2(poseidon.F);

  console.log(`=== Veil O1-vs-O2-vs-Poseidon2 Groth16 proving-time benchmark (${RUNS} runs per variant) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const results = [];

  for (const v of VARIANTS) {
    const wasmPath = join(CIRCUITS_DIR, v.dir, `${v.wasmName}_js`, `${v.wasmName}.wasm`);
    const zkeyPath = join(CIRCUITS_DIR, v.dir, `${v.zkeyName}.zkey`);
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      console.log(`[SKIP] ${v.label}: artifacts not found (${wasmPath})`);
      continue;
    }

    const inputs = v.poseidon2
      ? stringifyInputs(POSEIDON2_WITNESS_BUILDERS[v.kind](poseidon))
      : stringifyInputs(WITNESS_BUILDERS[v.kind](poseidon));
    const times = [];

    const warm = await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
    const valid = await snarkjs.groth16.verify(
      JSON.parse(await import("fs").then((fs) => fs.readFileSync(zkeyPath.replace("_final.zkey", "_vk.json"), "utf8"))),
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
    results.push({ label: v.label, runs: RUNS, meanMs: m, stddevMs: sd, minMs: Math.min(...times), maxMs: Math.max(...times), verified: valid });

    console.log(`--- ${v.label} ---`);
    console.log(`  mean: ${m.toFixed(2)} ms   stddev: ${sd.toFixed(2)} ms   min: ${Math.min(...times).toFixed(2)} ms   max: ${Math.max(...times).toFixed(2)} ms   verify: ${valid}`);
    console.log("");
  }

  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
