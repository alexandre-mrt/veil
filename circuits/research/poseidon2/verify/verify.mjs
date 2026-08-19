// Correctness cross-check for the vendored Poseidon2 circuit (circuits/research/poseidon2/vendor/,
// from @taceo/circom-lib). Two checks, both against independently-sourced code:
//
// 1. t=3 (Poseidon2Hash(2), the `poseidon2_n2` bench circuit): computed by a from-scratch JS
//    permutation (reference_permute_t3.mjs) written directly against the primary reference —
//    HorizenLabs/poseidon2's Rust implementation and its BN254 round constants — compared
//    against the compiled circom circuit's actual witness output for the same input.
// 2. t=4 (Poseidon2Hash(3), the `poseidon2_n3` bench circuit): compared against
//    @zkpassport/poseidon2's `permute()`, a second, separately-authored TypeScript
//    implementation (not derived from @taceo/circom-lib).
//
// Run: node verify.mjs   (from this directory, after the sibling ../bench/build/*_js/ wasm
// witness calculators have been built — see ../bench/README or the report for the compile step.)
import path from "node:path";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { permuteT3 } from "./reference_permute_t3.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_BUILD = path.join(__dirname, "..", "bench", "build");
const TMP = mkdtempSync(path.join(os.tmpdir(), "veil-poseidon2-verify-"));

// Uses snarkjs's own witness-calculator loading (not the generated witness_calculator.js
// helper directly, which is CommonJS and clashes with this package's "type": "module").
async function calculateWitness(circuitName, input) {
  const wasmPath = path.join(BENCH_BUILD, `${circuitName}_js`, `${circuitName}.wasm`);
  const wtnsPath = path.join(TMP, `${circuitName}.wtns`);
  await snarkjs.wtns.calculate(input, wasmPath, wtnsPath);
  return snarkjs.wtns.exportJson(wtnsPath);
}

function fmt(x) {
  return "0x" + x.toString(16).padStart(64, "0");
}

let failures = 0;

// --- Check 1: t=3, against a from-scratch reimplementation of the primary reference ---
{
  const state = [0n, 1n, 2n]; // capacity=0, inputs=[1,2] -- matches Poseidon2Hash(2) convention
  const refOut = permuteT3(state);
  const w = await calculateWitness("poseidon2_n2", { inputs: ["1", "2"] });
  const circuitOut = BigInt(w[1].toString());
  const ok = circuitOut === refOut[0];
  console.log(`[t=3] independent-JS-reference out[0] = ${fmt(refOut[0])}`);
  console.log(`[t=3] circom witness         main.out = ${fmt(circuitOut)}`);
  console.log(ok ? "[t=3] MATCH" : "[t=3] MISMATCH");
  if (!ok) failures++;
}

// --- Check 2: t=4, against @zkpassport/poseidon2 (independent TS implementation) ---
{
  const { permute } = await import("@zkpassport/poseidon2");
  const state = [0n, 1n, 2n, 3n]; // capacity=0, inputs=[1,2,3] -- matches Poseidon2Hash(3)
  const refOut = permute(state);
  const w = await calculateWitness("poseidon2_n3", { inputs: ["1", "2", "3"] });
  const circuitOut = BigInt(w[1].toString());
  const ok = circuitOut === BigInt(refOut[0]);
  console.log(`[t=4] @zkpassport/poseidon2  out[0] = ${fmt(BigInt(refOut[0]))}`);
  console.log(`[t=4] circom witness      main.out = ${fmt(circuitOut)}`);
  console.log(ok ? "[t=4] MATCH" : "[t=4] MISMATCH");
  if (!ok) failures++;
}

if (failures > 0) {
  console.error(`\n${failures} cross-check(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nAll cross-checks passed.");
}
