#!/usr/bin/env node
/**
 * poseidon2-cross-check.mjs — Correctness check for the Poseidon2 benchmark circuit
 * before citing any constraint or timing number derived from it.
 *
 * Computes the Poseidon2(t=4) permutation of [1,2,3,4] on BN254 using two
 * independent, unrelated JS implementations (@zkpassport/poseidon2 and
 * @platus-xyz/poseidon2 — different authors, different codebases, both
 * structurally following the published Poseidon2 paper), confirms they agree
 * with each other, then generates a real Groth16 proof from
 * circuits/bench/poseidon2_t4.circom (TACEO's @taceo/circom-lib port) and
 * confirms its public output matches.
 *
 * @platus-xyz/poseidon2's compiled ESM (as published) has broken relative
 * imports missing .js extensions — this script patches them in
 * node_modules in place before importing (see NOTE below), same as done
 * interactively during the research session this script documents.
 *
 * Usage: node scripts/bench/poseidon2-cross-check.mjs
 * Prerequisite: bash circuits/scripts/compile-poseidon-bench.sh (produces
 * circuits/bench/build/poseidon2_t4_js/poseidon2_t4.wasm + _final.zkey)
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const WASM_PATH = join(CIRCUITS_DIR, "bench", "build", "poseidon2_t4_js", "poseidon2_t4.wasm");
const ZKEY_PATH = join(CIRCUITS_DIR, "bench", "build", "poseidon2_t4_final.zkey");

const INPUT = [1n, 2n, 3n, 4n];

// NOTE: @platus-xyz/poseidon2@<= its published version ships dist/src/*.js
// with `type: "module"` but relative imports that omit the required .js
// extension (e.g. `from './roundConstants'`), which fails strict Node ESM
// resolution. Patch the installed copy in place (idempotent — regex only
// matches extension-less relative specifiers).
function patchPlatusEsm() {
  const pkgDir = join(__dirname, "node_modules", "@platus-xyz", "poseidon2", "dist", "src");
  if (!existsSync(pkgDir)) {
    throw new Error(`@platus-xyz/poseidon2 not found under ${pkgDir} — run npm install in scripts/`);
  }
  for (const p of walkJsFiles(pkgDir)) {
    const src = readFileSync(p, "utf8");
    const patched = src.replace(/from '(\.[^']*)'/g, (m, spec) => (spec.endsWith(".js") ? m : `from '${spec}.js'`));
    if (patched !== src) writeFileSync(p, patched);
  }
}

function walkJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkJsFiles(p));
    else if (entry.endsWith(".js")) out.push(p);
  }
  return out;
}

async function main() {
  console.log("=== Poseidon2(t=4) cross-check: two independent JS libs vs the circom circuit ===\n");

  patchPlatusEsm();

  const { permute: zkpPermute } = await import(
    pathToFileURL(join(__dirname, "node_modules", "@zkpassport", "poseidon2", "dist", "esm", "bn254", "index.js")),
  );
  const { poseidon2Permutation, bn254Field } = await import("@platus-xyz/poseidon2");

  const a = zkpPermute([...INPUT]);
  const b = poseidon2Permutation([...INPUT], bn254Field);
  const aStr = a.map(String);
  const bStr = b.map(String);

  console.log("input:", INPUT.map(String));
  console.log("@zkpassport/poseidon2 :", aStr);
  console.log("@platus-xyz/poseidon2 :", bStr);
  const jsLibsAgree = JSON.stringify(aStr) === JSON.stringify(bStr);
  console.log("independent JS libs agree:", jsLibsAgree);
  if (!jsLibsAgree) {
    console.error("FAIL: the two independent implementations disagree with each other — stopping.");
    process.exit(1);
  }

  if (!existsSync(WASM_PATH) || !existsSync(ZKEY_PATH)) {
    console.error(`\nSKIP circuit check: artifacts not found. Run:\n  bash circuits/scripts/compile-poseidon-bench.sh`);
    process.exit(1);
  }

  const { publicSignals } = await snarkjs.groth16.fullProve(
    { in: INPUT.map(String) },
    WASM_PATH,
    ZKEY_PATH,
  );
  console.log("\n@taceo/circom-lib Poseidon2(4) circuit output:", publicSignals);

  const circuitMatches = JSON.stringify(publicSignals) === JSON.stringify(aStr);
  console.log("circuit output matches both independent JS libs:", circuitMatches);

  if (!circuitMatches) {
    console.error("FAIL: circuit output does not match the independently-verified permutation.");
    process.exit(1);
  }
  console.log("\nPASS — TACEO's Poseidon2(4) circom port is correct for this input, independently verified.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Cross-check failed:", err);
  process.exit(1);
});
