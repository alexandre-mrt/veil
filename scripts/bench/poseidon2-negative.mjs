#!/usr/bin/env node
/**
 * poseidon2-negative.mjs — Negative test: a malicious witness claiming a wrong
 * Poseidon2 output must be rejected at witness-generation time.
 *
 * circuits/bench/poseidon2_check_t4.circom wraps the bare Poseidon2(4)
 * permutation with an explicit `claimedOut` input signal and a `claimedOut[i]
 * === computed[i]` constraint per element — the bare Poseidon2(4) template
 * used for the constraint/timing benchmark has no such failure mode on its
 * own (its output is always derived, never asserted), so this wrapper exists
 * solely to give a malicious-witness test something to attack.
 *
 * Usage: node scripts/bench/poseidon2-negative.mjs
 * Prerequisite: bash circuits/scripts/compile-poseidon-bench.sh
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const WASM_PATH = join(CIRCUITS_DIR, "bench", "build", "poseidon2_check_t4_js", "poseidon2_check_t4.wasm");
const ZKEY_PATH = join(CIRCUITS_DIR, "bench", "build", "poseidon2_check_t4_final.zkey");

const INPUT = ["1", "2", "3", "4"];
const CORRECT_OUT = [
  "15505005361706012551741834895355031099510014664842462842053262257331543442865",
  "15540689879131394802373076737172779194862932999849486641952351767738780953784",
  "7917159902307905727813080625122777309809151624119093977983495514817909259553",
  "10305078288915035001787281422329641624507094761680960003698404035062931519465",
];

async function main() {
  if (!existsSync(WASM_PATH) || !existsSync(ZKEY_PATH)) {
    console.error(`Artifacts not found. Run:\n  bash circuits/scripts/compile-poseidon-bench.sh`);
    process.exit(1);
  }

  console.log("--- Positive case: correct claimed output ---");
  try {
    await snarkjs.groth16.fullProve(
      { in: INPUT, claimedOut: CORRECT_OUT },
      WASM_PATH,
      ZKEY_PATH,
    );
    console.log("ACCEPTED (expected) — proof generated for a correctly-claimed output.\n");
  } catch (e) {
    console.error("FAIL: correct witness was rejected:", e.message);
    process.exit(1);
  }

  console.log("--- Negative case: tampered claimed output (malicious witness) ---");
  const tamperedOut = [...CORRECT_OUT];
  tamperedOut[0] = (BigInt(tamperedOut[0]) + 1n).toString();
  try {
    await snarkjs.groth16.fullProve(
      { in: INPUT, claimedOut: tamperedOut },
      WASM_PATH,
      ZKEY_PATH,
    );
    console.error("FAIL: malicious witness with a tampered claimed output was ACCEPTED.");
    process.exit(1);
  } catch (e) {
    console.log("REJECTED (expected) — witness calculation failed:", e.message);
  }

  console.log("\nPASS — the constrained wrapper accepts a correct witness and rejects a tampered one.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Negative test failed:", err);
  process.exit(1);
});
