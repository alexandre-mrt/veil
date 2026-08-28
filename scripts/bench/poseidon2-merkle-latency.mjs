#!/usr/bin/env node
/**
 * poseidon2-merkle-latency.mjs — Node-side Groth16 proving-time benchmark comparing
 * transfer.circom (production, circomlib Poseidon(2) Merkle-node hash) against
 * circuits/experiments/transfer_poseidon2.circom (identical circuit, Merkle-node
 * hash swapped to the Poseidon2 compression in templates/merkle_proof_poseidon2.circom).
 *
 * See docs/research/2026-08-28-poseidon2-merkle-hash.md.
 *
 * Usage:
 *   node scripts/bench/poseidon2-merkle-latency.mjs [--runs N]
 *
 * Prerequisite (produces the artifacts this script reads — see that doc for the
 * exact commands run to produce them):
 *   cd circuits
 *   circom transfer.circom --r1cs --wasm --sym --output build -l node_modules
 *   circom experiments/transfer_poseidon2.circom --r1cs --wasm --sym --output build-experiments/transfer-p2 -l node_modules
 *   # then snarkjs groth16 setup + zkey contribute + export verificationkey for each,
 *   # against the same build/pot15_final.ptau
 */
import { buildPoseidon } from "circomlibjs";
import { bn254 } from "@taceo/poseidon2";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

const DOMAIN_COMMITMENT = 1n;
const DOMAIN_NULLIFIER = 2n;
const DOMAIN_TX_AMOUNT = 3n;
const MERKLE_DEPTH = 20;

let poseidonF = null;
function toBI(val) {
  if (typeof val === "bigint") return val;
  if (poseidonF && val instanceof Uint8Array) return poseidonF.toObject(val);
  return BigInt(val);
}

function poseidon1MerkleRoot(poseidon, leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < pathElements.length; i++) {
    const [left, right] = pathIndices[i] === 0n ? [node, pathElements[i]] : [pathElements[i], node];
    node = toBI(poseidon([left, right]));
  }
  return node;
}

function poseidon2MerkleRoot(leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < pathElements.length; i++) {
    const [left, right] = pathIndices[i] === 0n ? [node, pathElements[i]] : [pathElements[i], node];
    const [out0] = bn254.t2.permutation([left, right]);
    node = (out0 + left) % 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  }
  return node;
}

function buildTransferInputs(poseidon, useMerkleRoot) {
  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const txAmountHash = toBI(poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const merkleRoot = useMerkleRoot(oldCommitment, pathElements, pathIndices);
  return {
    oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot,
    cumulativeOld, cumulativeNew, txAmount, randomnessOld, randomnessNew, userSecret, salt,
    pathElements, pathIndices,
  };
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) { return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }

function stringify(inputs) {
  const out = {};
  for (const [k, v] of Object.entries(inputs)) out[k] = Array.isArray(v) ? v.map(String) : String(v);
  return out;
}

async function benchCircuit(label, wasmPath, zkeyPath, inputs, runs) {
  if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
    console.log(`[SKIP] ${label}: artifacts not found`);
    return null;
  }
  const stringInputs = stringify(inputs);
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(stringInputs, wasmPath, zkeyPath);
    const t1 = performance.now();
    times.push(t1 - t0);
    if (i === 0) {
      // Sanity: proof must actually verify.
      const vk = JSON.parse(await (await import("fs/promises")).readFile(zkeyPath.replace("_final.zkey", "_vk.json"), "utf8"));
      const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
      if (!valid) throw new Error(`${label}: generated proof does not verify`);
    }
  }
  const m = mean(times), sd = stddev(times, m);
  console.log(`${label}: mean ${m.toFixed(1)} ms (sigma ${sd.toFixed(1)}, n=${runs})`);
  return { label, mean: m, stddev: sd, runs };
}

async function main() {
  const poseidon = await buildPoseidon();
  poseidonF = poseidon.F;

  console.log(`=== Poseidon2-Merkle proving-time benchmark (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const baselineInputs = buildTransferInputs(poseidon, (leaf, pe, pi) => poseidon1MerkleRoot(poseidon, leaf, pe, pi));
  const poseidon2Inputs = buildTransferInputs(poseidon, poseidon2MerkleRoot);

  await benchCircuit(
    "transfer.circom (Poseidon Merkle, production)",
    join(CIRCUITS_DIR, "build", "transfer_js", "transfer.wasm"),
    join(CIRCUITS_DIR, "build", "transfer_final.zkey"),
    baselineInputs,
    RUNS,
  );

  await benchCircuit(
    "transfer_poseidon2.circom (Poseidon2 Merkle, experimental)",
    join(CIRCUITS_DIR, "build-experiments", "transfer-p2", "transfer_poseidon2_js", "transfer_poseidon2.wasm"),
    join(CIRCUITS_DIR, "build-experiments", "transfer-p2", "transfer_poseidon2_final.zkey"),
    poseidon2Inputs,
    RUNS,
  );
}

main()
  .then(() => process.exit(0)) // real snarkjs.groth16 calls otherwise leave the process alive (see LEDGER.md 2026-07-22 / EXPERIMENTS.md item 12)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
