#!/usr/bin/env node
/**
 * poseidon2-negative-test.mjs — proves a malicious witness is rejected by the Poseidon2
 * variant circuits (circuits/bench/poseidon2/full/*_v2.circom).
 *
 * Two cases, both against withdraw_v2 (compiled build/withdraw_v2_js/withdraw_v2.wasm):
 *   1. Forged commitment: `commitment` public input set to an arbitrary value instead of
 *      Poseidon2Sponge(3,4,1)(cumulativeOld, randomnessOld, userSecret) - simulates a prover
 *      claiming ownership of a note they cannot open.
 *   2. Forged nullifier: `nullifier` public input set to an arbitrary value instead of the
 *      correctly-derived one - simulates a prover trying to submit a withdrawal whose
 *      nullifier doesn't match their commitment (would let them evade the on-chain
 *      double-spend check for a different note).
 * Both must fail witness generation (the R1CS `===` constraint is violated) - if either
 * succeeds, the Poseidon2 swap has introduced an under-constrained signal.
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { buildWithdrawWitnessV2, stringifyInputs } from "./witnesses-v2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "..", "..", "circuits", "bench", "poseidon2", "full", "build");

async function calculateWitness(file, input) {
  const wcPath = join(BUILD_DIR, `${file}_js`, "witness_calculator.js");
  const wasmPath = join(BUILD_DIR, `${file}_js`, `${file}.wasm`);
  const src = readFileSync(wcPath, "utf8");
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  const builder = mod.exports;
  const buffer = readFileSync(wasmPath);
  const wc = await builder(buffer);
  return wc.calculateWitness(input, true);
}

async function main() {
  const honest = stringifyInputs(buildWithdrawWitnessV2());

  console.log("--- Sanity check: honest witness_v2 is accepted ---");
  try {
    await calculateWitness("withdraw_v2", honest);
    console.log("PASS: honest witness accepted\n");
  } catch (e) {
    console.error("FAIL: honest witness was rejected -- something is broken before we even get to the negative tests:");
    console.error(e.message);
    process.exit(1);
  }

  const cases = [
    { name: "forged commitment", tamper: (w) => ({ ...w, commitment: (BigInt(w.commitment) + 1n).toString() }) },
    { name: "forged nullifier", tamper: (w) => ({ ...w, nullifier: (BigInt(w.nullifier) + 1n).toString() }) },
  ];

  let allRejected = true;
  for (const c of cases) {
    console.log(`--- Negative test: ${c.name} ---`);
    const malicious = c.tamper(honest);
    try {
      await calculateWitness("withdraw_v2", malicious);
      console.error(`FAIL: ${c.name} was ACCEPTED -- under-constrained signal!`);
      allRejected = false;
    } catch (e) {
      console.log(`PASS: rejected. snarkjs/wasm error: ${e.message.split("\n")[0]}`);
    }
    console.log();
  }

  if (!allRejected) {
    console.error("At least one malicious witness was accepted. FAILED.");
    process.exit(1);
  }
  console.log("All malicious witnesses correctly rejected.");
}

main();
