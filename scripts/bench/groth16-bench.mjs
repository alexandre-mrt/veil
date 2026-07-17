#!/usr/bin/env node
/**
 * groth16-bench.mjs — reproducible Groth16 baseline for all three Veil circuits.
 *
 * Measures, per circuit, on this machine:
 *   - R1CS constraint count (already reported by circom/snarkjs at compile time)
 *   - witness generation time
 *   - Groth16 prove time
 *   - Groth16 verify time
 *   - proof.json size, verification_key.json size, final .zkey size
 *
 * Requires circuits/build{,-compliance,-withdraw}/ to already contain the compiled
 * wasm + final zkey (see circuits/scripts/compile*.sh, or docs/research/2026-07-17-groth16-baseline.md
 * for the exact commands used to produce them).
 *
 * Usage: node scripts/bench/groth16-bench.mjs
 */

import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { readFileSync, writeFileSync, statSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildTransferInput, buildComplianceInput, buildWithdrawInput } from "./witness-inputs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CIRCUITS = join(ROOT, "circuits");

const CIRCUITS_CONFIG = [
  { name: "transfer", buildDir: "build", buildInput: buildTransferInput },
  { name: "compliance", buildDir: "build-compliance", buildInput: buildComplianceInput },
  { name: "withdraw", buildDir: "build-withdraw", buildInput: buildWithdrawInput },
];

async function benchCircuit(F, poseidon, cfg) {
  const dir = join(CIRCUITS, cfg.buildDir);
  const wasmPath = join(dir, `${cfg.name}_js`, `${cfg.name}.wasm`);
  const zkeyPath = join(dir, `${cfg.name}_final.zkey`);
  const vkPath = join(dir, `${cfg.name}_vk.json`);
  const r1csPath = join(dir, `${cfg.name}.r1cs`);

  if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
    return { name: cfg.name, error: `missing build artifacts in ${dir} — run circuits/scripts/compile*.sh first` };
  }

  const input = await cfg.buildInput(F, poseidon);
  const wtnsPath = join(dir, `${cfg.name}_bench.wtns`);
  const proofPath = join(dir, `${cfg.name}_bench_proof.json`);
  const publicPath = join(dir, `${cfg.name}_bench_public.json`);

  const ITERATIONS = 5;
  const witnessMs = [], proveMs = [], verifyMs = [];
  let proof, publicSignals, ok;

  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    await snarkjs.wtns.calculate(input, wasmPath, wtnsPath);
    const t1 = performance.now();

    ({ proof, publicSignals } = await snarkjs.groth16.prove(zkeyPath, wtnsPath));
    const t2 = performance.now();

    const vk = JSON.parse(readFileSync(vkPath, "utf-8"));
    ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
    const t3 = performance.now();

    witnessMs.push(t1 - t0);
    proveMs.push(t2 - t1);
    verifyMs.push(t3 - t2);
  }

  writeFileSync(proofPath, JSON.stringify(proof));
  writeFileSync(publicPath, JSON.stringify(publicSignals));

  const median = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];

  return {
    name: cfg.name,
    iterations: ITERATIONS,
    witnessMsAll: witnessMs.map((x) => +x.toFixed(1)),
    proveMsAll: proveMs.map((x) => +x.toFixed(1)),
    verifyMsAll: verifyMs.map((x) => +x.toFixed(1)),
    witnessMs: median(witnessMs),
    proveMs: median(proveMs),
    verifyMs: median(verifyMs),
    verifyOk: ok,
    r1csBytes: statSync(r1csPath).size,
    zkeyBytes: statSync(zkeyPath).size,
    vkBytes: statSync(vkPath).size,
    proofBytes: statSync(proofPath).size,
    publicBytes: statSync(publicPath).size,
  };
}

async function main() {
  const poseidonInstance = await buildPoseidon();
  const F = poseidonInstance.F;
  const poseidon = (arr) => poseidonInstance(arr);

  const results = [];
  for (const cfg of CIRCUITS_CONFIG) {
    console.log(`=== ${cfg.name} ===`);
    const r = await benchCircuit(F, poseidon, cfg);
    console.log(JSON.stringify(r, null, 2));
    results.push(r);
  }

  console.log(`\n=== summary (median of ${CIRCUITS_CONFIG.length ? results[0]?.iterations ?? "?" : "?"} runs, markdown) ===`);
  console.log("| Circuit | Witness ms (median) | Prove ms (median) | Verify ms (median) | Proof size (B) | VK size (B) | zkey size (B) | Verified |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    if (r.error) { console.log(`| ${r.name} | ERROR: ${r.error} |`); continue; }
    console.log(`| ${r.name} | ${r.witnessMs.toFixed(1)} | ${r.proveMs.toFixed(1)} | ${r.verifyMs.toFixed(1)} | ${r.proofBytes} | ${r.vkBytes} | ${r.zkeyBytes} | ${r.verifyOk} |`);
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
