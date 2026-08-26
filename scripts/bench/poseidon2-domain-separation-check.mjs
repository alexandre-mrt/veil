#!/usr/bin/env node
/**
 * poseidon2-domain-separation-check.mjs — sanity check for @taceo/circom-lib's
 * Poseidon2Sponge domain-separation approach (queue item #2's "domain-tag collisions"
 * question). Veil's current circuits bake the domain tag into in[0] of Poseidon(n)
 * (a rate element, mixed with real data). Poseidon2Sponge instead puts the domain tag
 * `ds` into the sponge's capacity element, never absorbed into the rate at all.
 *
 * This does not re-derive or attack that construction's security proof (out of scope
 * for one night) -- it just confirms the concrete, expected behavior holds for the
 * exact circuit this experiment benched: same inputs + same ds -> same output
 * (determinism), same inputs + different ds -> different output (no accidental
 * collision for the two tags tried).
 *
 * Prerequisite: circuits/bench-poseidon2/poseidon2_ds_test.circom compiled to
 * circuits/bench-poseidon2/build/poseidon2_ds_test_js/poseidon2_ds_test.wasm
 * (part of scripts/bench/compile-poseidon2-bench.sh).
 *
 * Usage: node scripts/bench/poseidon2-domain-separation-check.mjs
 */
import { WitnessCalculatorBuilder } from "circom_runtime";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(
  __dirname, "..", "..", "circuits", "bench-poseidon2", "build",
  "poseidon2_ds_test_js", "poseidon2_ds_test.wasm"
);

async function main() {
  if (!existsSync(wasmPath)) {
    console.log(`[SKIP] artifacts not found (${wasmPath}) — run compile-poseidon2-bench.sh first`);
    return;
  }
  const wasm = readFileSync(wasmPath);
  const wc = await WitnessCalculatorBuilder(wasm);

  async function hash(ds) {
    const w = await wc.calculateWitness({ in: [1, 2, 3, 4], ds }, false);
    return w[1].toString(); // witness[0] = 1 (constant), witness[1] = public output `out`
  }

  const outA = await hash("111");
  const outB = await hash("222");
  const outARepeat = await hash("111");

  console.log("same in[], ds=111        -> out:", outA);
  console.log("same in[], ds=222        -> out:", outB);
  console.log("same in[], ds=111 repeat -> out:", outARepeat);

  const deterministic = outA === outARepeat;
  const noCollision = outA !== outB;
  console.log(`\nsame (in, ds) -> same output (determinism):        ${deterministic}`);
  console.log(`different ds -> different output (no collision):    ${noCollision}`);

  if (!deterministic || !noCollision) {
    console.error("\nFAIL: domain-separation sanity check did not hold.");
    process.exit(1);
  }
  console.log("\nPASS");
}

main().catch((err) => {
  console.error("Check failed:", err);
  process.exit(1);
});
