#!/usr/bin/env node
/**
 * verify-poseidon2-sponge.mjs — cross-checks poseidon2-sponge.mjs's JS implementation
 * against the actual witness computed by the compiled new_merkle2 / new_recipient2 /
 * new_amount3 / new_commit4 circuits (circuits/bench/poseidon2/build/*_js/*.wasm).
 * If this doesn't print MATCH for all four, the full-circuit witnesses built with
 * poseidon2-sponge.mjs cannot be trusted.
 */
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { poseidon2Sponge } from "./poseidon2-sponge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "..", "..", "circuits", "bench", "poseidon2", "build");
const require = createRequire(import.meta.url);

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

const CASES = [
  { file: "new_merkle2", input: { in: ["1", "2"] }, jsOut: poseidon2Sponge([1n, 2n], 3, 0) },
  { file: "new_recipient2", input: { data: "42" }, jsOut: poseidon2Sponge([42n], 2, 8) },
  { file: "new_amount3", input: { data: ["100", "7"] }, jsOut: poseidon2Sponge([100n, 7n], 3, 3) },
  { file: "new_commit4", input: { data: ["55", "77", "99"] }, jsOut: poseidon2Sponge([55n, 77n, 99n], 4, 1) },
];

let allMatch = true;
for (const c of CASES) {
  const witness = await calculateWitness(c.file, c.input);
  // witness[0] = 1 (constant), witness[1] = public output "out"
  const circuitOut = witness[1];
  const match = circuitOut === c.jsOut;
  allMatch = allMatch && match;
  console.log(`${c.file}: circuit=${circuitOut} js=${c.jsOut} -> ${match ? "MATCH" : "MISMATCH"}`);
}

if (!allMatch) {
  console.error("\nFAILED: JS Poseidon2 sponge does not match the compiled circuit's witness.");
  process.exit(1);
}
console.log("\nAll four Poseidon2Sponge shapes match between JS and the compiled circom circuit.");
