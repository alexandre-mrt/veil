#!/usr/bin/env node
/**
 * negative-test.mjs — malicious-witness rejection test for the Poseidon2T3
 * benchmark-only permutation (research/poseidon-bench/poseidon2_t3_template.circom).
 *
 * This gadget is not part of any production statement (nothing in
 * transfer.circom / compliance.circom / withdraw.circom includes it), so there is no
 * protocol-level "malicious prover" scenario to defend against. What IS worth proving,
 * the same way transfer.circom's own C1 (`oldCommitment === oldHash.out`) is tested in
 * circuits/test/transfer.test.mjs, is that the circuit's constraints actually pin the
 * output to the one value the permutation computes — i.e. that a witness asserting a
 * different output for the same inputs is rejected, not silently accepted.
 *
 * Uses snarkjs wtns.calculate directly against the compiled wasm (no zkey/ptau needed —
 * witness generation alone is enough to demonstrate constraint (un)satisfiability).
 *
 * Usage: node research/poseidon-bench/negative-test.mjs
 */
import { WitnessCalculatorBuilder } from "circom_runtime";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PLAIN = join(__dirname, "build/poseidon2_t3_js/poseidon2_t3.wasm");
const WASM_CHECKED = join(__dirname, "build/poseidon2_t3_checked_js/poseidon2_t3_checked.wasm");

async function calc(wasmPath, input) {
  const wasm = await readFile(wasmPath);
  const wc = await WitnessCalculatorBuilder(wasm);
  // sanityCheck=true makes the wasm witness calculator itself evaluate every R1CS
  // constraint as it goes and throw on the first violation — this is the check we want.
  return wc.calculateWitness(input, /* sanityCheck */ true);
}

async function main() {
  const inputs = { inputs: ["3", "7"] };

  // Step 1: compute the real Poseidon2T3 output for inputs=[3,7] via the plain wrapper.
  const w = await calc(WASM_PLAIN, inputs);
  const realOut = w[1]; // witness[0] is the constant 1; witness[1] is the sole public output `out`
  console.log(`Poseidon2T3([3,7]) = ${realOut.toString()}`);

  // Step 2: positive control — expectedOut = realOut must be ACCEPTED.
  let acceptedOk = false;
  try {
    await calc(WASM_CHECKED, { inputs: ["3", "7"], expectedOut: realOut.toString() });
    acceptedOk = true;
  } catch (e) {
    console.error("POSITIVE CONTROL FAILED (should have been accepted):", e.message);
  }
  console.log(`Positive control (expectedOut = real output): ${acceptedOk ? "ACCEPTED (correct)" : "REJECTED (BUG)"}`);

  // Step 3: malicious witness — expectedOut = realOut + 1 must be REJECTED.
  let maliciousRejected = false;
  try {
    await calc(WASM_CHECKED, { inputs: ["3", "7"], expectedOut: (realOut + 1n).toString() });
  } catch (e) {
    maliciousRejected = true;
    console.log(`Malicious witness (expectedOut = real output + 1): REJECTED (correct) — "${e.message}"`);
  }
  if (!maliciousRejected) {
    console.error("MALICIOUS WITNESS ACCEPTED — SOUNDNESS BUG");
    process.exit(1);
  }

  if (!acceptedOk) process.exit(1);
  console.log("\nAll checks passed: the constraint system enforces expectedOut === Poseidon2T3(inputs).");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
