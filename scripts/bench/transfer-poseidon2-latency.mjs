#!/usr/bin/env node
/**
 * transfer-poseidon2-latency.mjs — Full-circuit Groth16 proving-time A/B:
 * circuits/transfer.circom (baseline, circomlib Poseidon Merkle hash) vs
 * circuits/transfer_poseidon2.circom (research variant, Poseidon2-compression Merkle hash —
 * see docs/research/2026-09-17-poseidon2-merkle-compression.md).
 *
 * Both circuits are proven with the SAME synthetic genesis-transfer witness (only the Merkle
 * root differs, since the two circuits use different node hash functions for C0) and the same
 * machine/session's local trusted setup, so the only variable between the two timings is the
 * Merkle hash construction.
 *
 * Usage:
 *   node scripts/bench/transfer-poseidon2-latency.mjs [--runs N]
 *
 * Prerequisite (produces the artifacts this script reads):
 *   cd circuits
 *   circom transfer.circom --r1cs --wasm --sym --output build -l node_modules
 *   circom transfer_poseidon2.circom --r1cs --wasm --sym --output build-poseidon2 -l node_modules
 *   # Groth16 setup (local ptau, >= 16384 = 2^14) for both — see
 *   # scripts/bench/poseidon-arity-compile.sh for the same offline-ptau pattern, or
 *   # circuits/scripts/compile.sh for the project's usual (network) ptau source.
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { bn254 } from "@taceo/poseidon2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 15;
})();

const BN254_FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function stddev(a, m) { return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); }

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const toBI = (v) => F.toObject(v);

  const cumulativeOld = 0n, txAmount = 100n, randomnessOld = 0n, randomnessNew = 12345n;
  const userSecret = 987654321n, epochId = 1n, threshold = 1000000000n, salt = 99n;
  const cumulativeNew = cumulativeOld + txAmount;
  const oldCommitment = toBI(poseidon([1n, cumulativeOld, randomnessOld, userSecret]));
  const newCommitment = toBI(poseidon([1n, cumulativeNew, randomnessNew, userSecret]));
  const nullifier = toBI(poseidon([2n, userSecret, epochId, randomnessOld]));
  const txAmountHash = toBI(poseidon([3n, txAmount, salt]));
  const pathElements = Array.from({ length: 20 }, () => "0");
  const pathIndices = Array.from({ length: 20 }, () => "0");

  // transfer.circom's Merkle root: circomlib Poseidon(2) sponge, all-zero siblings
  let rootPoseidon = oldCommitment;
  for (let i = 0; i < 20; i++) rootPoseidon = toBI(poseidon([rootPoseidon, 0n]));

  // transfer_poseidon2.circom's Merkle root: Poseidon2 compression, same path shape
  let rootPoseidon2 = oldCommitment;
  for (let i = 0; i < 20; i++) {
    const [p0] = bn254.t2.permutation([rootPoseidon2, 0n]);
    rootPoseidon2 = (p0 + rootPoseidon2) % BN254_FR;
  }

  const base = {
    oldCommitment: oldCommitment.toString(), newCommitment: newCommitment.toString(),
    threshold: threshold.toString(), epochId: epochId.toString(), nullifier: nullifier.toString(),
    txAmountHash: txAmountHash.toString(), cumulativeOld: cumulativeOld.toString(),
    cumulativeNew: cumulativeNew.toString(), txAmount: txAmount.toString(),
    randomnessOld: randomnessOld.toString(), randomnessNew: randomnessNew.toString(),
    userSecret: userSecret.toString(), salt: salt.toString(), pathElements, pathIndices,
  };

  const CIRCUITS = [
    { name: "transfer", wasm: join(CIRCUITS_DIR, "build/transfer_js/transfer.wasm"), zkey: join(CIRCUITS_DIR, "build/transfer_final.zkey"), input: { ...base, merkleRoot: rootPoseidon.toString() } },
    { name: "transfer_poseidon2", wasm: join(CIRCUITS_DIR, "build-poseidon2/transfer_poseidon2_js/transfer_poseidon2.wasm"), zkey: join(CIRCUITS_DIR, "build-poseidon2/transfer_poseidon2_final.zkey"), input: { ...base, merkleRoot: rootPoseidon2.toString() } },
  ];

  console.log(`=== transfer.circom vs transfer_poseidon2.circom Groth16 proving-time A/B (${RUNS} runs each) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  for (const c of CIRCUITS) {
    if (!existsSync(c.wasm) || !existsSync(c.zkey)) {
      console.log(`[SKIP] ${c.name}: artifacts not found (${c.wasm})`);
      continue;
    }
    await snarkjs.groth16.fullProve(c.input, c.wasm, c.zkey); // warm-up
    const times = [];
    for (let i = 0; i < RUNS; i++) {
      const start = process.hrtime.bigint();
      await snarkjs.groth16.fullProve(c.input, c.wasm, c.zkey);
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    const m = mean(times);
    console.log(`--- ${c.name} ---`);
    console.log(`  runs: ${RUNS}   mean: ${m.toFixed(2)} ms   stddev: ${stddev(times, m).toFixed(2)} ms   min: ${Math.min(...times).toFixed(2)} ms   max: ${Math.max(...times).toFixed(2)} ms\n`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
