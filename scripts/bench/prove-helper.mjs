#!/usr/bin/env node
/**
 * prove-helper.mjs — generates one real Groth16 proof and writes {proof, publicSignals} JSON.
 *
 * snarkjs.groth16.fullProve spins up worker_threads for the multi-exponentiation/FFT; Bun's
 * worker_threads/EventTarget shim crashes on that path (`web-worker` package,
 * "Argument 1 ('event') to EventTarget.dispatchEvent must be an instance of Event"). Every other
 * real-proving path in this repo (circuits/test/*.test.mjs, scripts/bench/prove-latency.mjs)
 * already runs under plain Node for the same reason. This script is the same escape hatch for
 * scripts/bench/onchain-gas.ts, which otherwise runs under bun for the @mysten/sui SDK calls.
 *
 * Usage: node prove-helper.mjs <wasmPath> <zkeyPath> <vkPath> <inputJsonPath> <outputJsonPath>
 */
import { readFileSync, writeFileSync } from "fs";
import * as snarkjs from "snarkjs";

const [, , wasmPath, zkeyPath, vkPath, inputPath, outputPath] = process.argv;
if (!wasmPath || !zkeyPath || !vkPath || !inputPath || !outputPath) {
  console.error("Usage: node prove-helper.mjs <wasmPath> <zkeyPath> <vkPath> <inputJsonPath> <outputJsonPath>");
  process.exit(1);
}

const input = JSON.parse(readFileSync(inputPath, "utf-8"));
const vk = JSON.parse(readFileSync(vkPath, "utf-8"));
const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
const verified = await snarkjs.groth16.verify(vk, publicSignals, proof);
writeFileSync(outputPath, JSON.stringify({ proof, publicSignals, verified }));
process.exit(0);
