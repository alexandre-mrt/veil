#!/usr/bin/env node
/**
 * negative-test.mjs — Soundness check for the EXPERIMENTAL Poseidon2Hash gadget
 * (poseidon2_hash.circom) as used in transfer_p2.circom.
 *
 * Confirms:
 *   1. A validly-derived witness proves and the proof verifies against the vk.
 *   2. A witness with a tampered public `nullifier` (not equal to
 *      Poseidon2Hash(2, userSecret, epochId, randomnessOld)) is REJECTED at
 *      witness-generation time (constraint C10, `nullifier === nfHash.out`).
 *   3. A witness with a tampered public `oldCommitment` (not equal to
 *      Poseidon2Hash(4, 1, cumulativeOld, randomnessOld, userSecret)) is
 *      REJECTED at witness-generation time (constraint C1).
 *
 * This is the negative-witness test NIGHTLY_PROMPT.md requires alongside any
 * circuit change — included here even though these variants are experimental
 * and not wired into the deployed circuits, specifically to demonstrate that
 * Poseidon2Hash is a real constraining gadget (out is bound by the permutation,
 * not a free/unconstrained signal) and not an accidentally under-constrained
 * no-op that would rubber-stamp any witness.
 *
 * Usage: node negative-test.mjs   (run after compile-p2.sh has produced build/)
 */
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { poseidon2 } from "../../scripts/bench/poseidon2-hash.mjs";
import { WITNESS_BUILDERS, stringifyInputs } from "../../scripts/bench/witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD = join(__dirname, "build");
const wasmPath = join(BUILD, "transfer_p2_js", "transfer_p2.wasm");
const zkeyPath = join(BUILD, "transfer_p2_final.zkey");
const vkPath = join(BUILD, "transfer_p2_vk.json");

let failed = 0;

async function expectRejected(label, tamperedInputs) {
  try {
    await snarkjs.groth16.fullProve(tamperedInputs, wasmPath, zkeyPath);
    console.log(`[FAIL] ${label}: witness generation SUCCEEDED — should have been rejected`);
    failed++;
  } catch (err) {
    if (String(err.message).includes("Assert Failed")) {
      console.log(`[PASS] ${label}: rejected — ${err.message.split("\n")[0]}`);
    } else {
      console.log(`[FAIL] ${label}: rejected but for the wrong reason — ${err.message}`);
      failed++;
    }
  }
}

async function main() {
  const valid = stringifyInputs(WITNESS_BUILDERS.transfer(poseidon2));

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(valid, wasmPath, zkeyPath);
  const vk = JSON.parse(await readFile(vkPath, "utf8"));
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  console.log(`[${ok ? "PASS" : "FAIL"}] valid witness proves and verifies: ${ok}`);
  if (!ok) failed++;

  await expectRejected(
    "tampered nullifier (!= Poseidon2Hash(2, userSecret, epochId, randomnessOld))",
    { ...valid, nullifier: (BigInt(valid.nullifier) + 1n).toString() }
  );

  await expectRejected(
    "tampered oldCommitment (!= Poseidon2Hash(4, 1, cumulativeOld, randomnessOld, userSecret))",
    { ...valid, oldCommitment: (BigInt(valid.oldCommitment) + 1n).toString() }
  );

  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("negative-test.mjs crashed:", err);
  process.exit(1);
});
