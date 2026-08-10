#!/usr/bin/env node
/**
 * transfer-poseidon2-latency.mjs — full-circuit Groth16 proving-time
 * comparison: production circuits/transfer.circom vs the research prototype
 * scripts/bench/circuits/transfer_poseidon2.circom (Merkle sponge + 3-input
 * hash swapped to Poseidon2; 4-input commitment/nullifier hashes unchanged —
 * see that file's header comment for why).
 *
 * Requires artifacts built by:
 *   cd circuits && circom transfer.circom --r1cs --wasm --sym --output build -l node_modules
 *   (+ groth16 setup / zkey contribute against build/pot15_final.ptau)
 *   scripts/bench/circuits/build.sh (for transfer_poseidon2)
 *
 * Usage: node scripts/bench/transfer-poseidon2-latency.mjs [--runs N]
 */
import { buildPoseidon } from "circomlibjs";
import { bn254 } from "@taceo/poseidon2";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const BENCH_CIRCUITS_DIR = join(__dirname, "circuits");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

const DOMAIN_COMMITMENT = 1n, DOMAIN_NULLIFIER = 2n, DOMAIN_TX_AMOUNT = 3n;
const MERKLE_DEPTH = 20;

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) { return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }

function toBI(F, val) {
  if (typeof val === "bigint") return val;
  if (val instanceof Uint8Array) return F.toObject(val);
  return BigInt(val);
}

// Sponge matching templates/merkle_proof_poseidon2.circom exactly: capacity
// 0, rate = [left, right], output = permuted[0].
function poseidon2Node(left, right) {
  return bn254.t3.permutation([0n, left, right])[0];
}

function merkleRootPoseidon(poseidon, F, leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    const [l, r] = pathIndices[i] === 0n ? [node, pathElements[i]] : [pathElements[i], node];
    node = toBI(F, poseidon([l, r]));
  }
  return node;
}

function merkleRootPoseidon2(leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    const [l, r] = pathIndices[i] === 0n ? [node, pathElements[i]] : [pathElements[i], node];
    node = poseidon2Node(l, r);
  }
  return node;
}

async function timeProve(label, inputs, wasmPath, zkeyPath, runs) {
  const warm = await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    await snarkjs.groth16.fullProve(inputs, wasmPath, zkeyPath);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  const m = mean(times), sd = stddev(times, m);
  console.log(`--- ${label} ---`);
  console.log(`  runs: ${runs}`);
  console.log(`  mean: ${m.toFixed(2)} ms   stddev: ${sd.toFixed(2)} ms   min: ${Math.min(...times).toFixed(2)} ms   max: ${Math.max(...times).toFixed(2)} ms`);
  return { label, meanMs: m, stddevMs: sd, minMs: Math.min(...times), maxMs: Math.max(...times) };
}

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  console.log(`=== transfer.circom vs transfer_poseidon2.circom proving-time (${RUNS} runs each) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1_000_000_000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = toBI(F, poseidon([DOMAIN_COMMITMENT, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(F, poseidon([DOMAIN_COMMITMENT, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(F, poseidon([DOMAIN_NULLIFIER, userSecret, epochId, randomnessOld]));
  const pathElements = Array.from({ length: MERKLE_DEPTH }, () => 0n);
  const pathIndices = Array.from({ length: MERKLE_DEPTH }, () => 0n);

  const results = [];

  // Production: Poseidon(2) Merkle + Poseidon(3) txAmountHash
  {
    const txAmountHash = toBI(F, poseidon([DOMAIN_TX_AMOUNT, txAmount, salt]));
    const merkleRoot = merkleRootPoseidon(poseidon, F, oldCommitment, pathElements, pathIndices);
    const inputs = {
      oldCommitment: oldCommitment.toString(), newCommitment: newCommitment.toString(),
      threshold: threshold.toString(), epochId: epochId.toString(), nullifier: nullifier.toString(),
      txAmountHash: txAmountHash.toString(), merkleRoot: merkleRoot.toString(),
      cumulativeOld: cumulativeOld.toString(), cumulativeNew: cumulativeNew.toString(),
      txAmount: txAmount.toString(), randomnessOld: randomnessOld.toString(), randomnessNew: randomnessNew.toString(),
      userSecret: userSecret.toString(), salt: salt.toString(),
      pathElements: pathElements.map(String), pathIndices: pathIndices.map(String),
    };
    const wasmPath = join(CIRCUITS_DIR, "build", "transfer_js", "transfer.wasm");
    const zkeyPath = join(CIRCUITS_DIR, "build", "transfer_final.zkey");
    if (existsSync(wasmPath) && existsSync(zkeyPath)) {
      results.push(await timeProve("transfer.circom (production, Poseidon)", inputs, wasmPath, zkeyPath, RUNS));
    } else {
      console.log(`[SKIP] production transfer: artifacts not found (${wasmPath})`);
    }
  }

  // Prototype: Poseidon2(3) Merkle + Poseidon2(4) txAmountHash
  {
    const txAmountHash = bn254.t4.permutation([0n, DOMAIN_TX_AMOUNT, txAmount, salt])[0];
    const merkleRoot = merkleRootPoseidon2(oldCommitment, pathElements, pathIndices);
    const inputs = {
      oldCommitment: oldCommitment.toString(), newCommitment: newCommitment.toString(),
      threshold: threshold.toString(), epochId: epochId.toString(), nullifier: nullifier.toString(),
      txAmountHash: txAmountHash.toString(), merkleRoot: merkleRoot.toString(),
      cumulativeOld: cumulativeOld.toString(), cumulativeNew: cumulativeNew.toString(),
      txAmount: txAmount.toString(), randomnessOld: randomnessOld.toString(), randomnessNew: randomnessNew.toString(),
      userSecret: userSecret.toString(), salt: salt.toString(),
      pathElements: pathElements.map(String), pathIndices: pathIndices.map(String),
    };
    const wasmPath = join(BENCH_CIRCUITS_DIR, "build", "transfer_poseidon2_js", "transfer_poseidon2.wasm");
    const zkeyPath = join(BENCH_CIRCUITS_DIR, "build", "transfer_poseidon2_final.zkey");
    if (existsSync(wasmPath) && existsSync(zkeyPath)) {
      results.push(await timeProve("transfer_poseidon2.circom (prototype)", inputs, wasmPath, zkeyPath, RUNS));
    } else {
      console.log(`[SKIP] transfer_poseidon2: artifacts not found (${wasmPath})`);
    }
  }

  console.log("\n=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
