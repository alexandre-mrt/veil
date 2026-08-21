/**
 * kat_check.mjs — Independent cross-validation of @taceo/circom-lib's Poseidon2
 * circom templates, run BEFORE any production/shadow circuit trusts them.
 *
 * Two probe circuits (kat_probe.circom: Poseidon2Sponge at T=4;
 * kat_probe_t2.circom: TACEO_PRECOMPUTATION_Poseidon2 compression at T=2 —
 * the two constructions Veil's *2 shadow circuits actually use) are compiled
 * and their witness output compared against a from-scratch JS
 * re-implementation of the same sponge/compression construction, built
 * directly on @taceo/poseidon2's raw bn254.tN.permutation() — no shared code
 * path with @taceo/circom-lib's circom template.
 *
 * Prerequisite (from circuits/):
 *   node node_modules/circom2/cli.js test/poseidon2-kat/kat_probe.circom --r1cs --wasm --sym -o test/poseidon2-kat -l node_modules
 *   node node_modules/circom2/cli.js test/poseidon2-kat/kat_probe_t2.circom --r1cs --wasm --sym -o test/poseidon2-kat -l node_modules
 *
 * Run: node test/poseidon2-kat/kat_check.mjs
 */
import { bn254 } from "@taceo/poseidon2";
import * as snarkjs from "snarkjs";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let failed = false;

async function witnessOutput(inputs, wasmPath) {
  const wtnsPath = join(__dirname, `_tmp_${Date.now()}.wtns`);
  await snarkjs.wtns.calculate(inputs, wasmPath, wtnsPath);
  const wtnsJson = await snarkjs.wtns.exportJson(wtnsPath);
  return BigInt(wtnsJson[1]); // [0] = constant 1, [1] = first public output
}

// ── T=4 sponge (used for every domain-tagged hash in the *2 shadow circuits) ──
{
  const wasmPath = join(__dirname, "kat_probe_js", "kat_probe.wasm");
  if (!existsSync(wasmPath)) {
    console.log("[SKIP] kat_probe not compiled — see prerequisite comment above.");
  } else {
    const inputs = [11n, 22n, 33n];
    const DS = 1n;
    // Re-implementation of Poseidon2SpongeWithDs: state = zeros with DS in the
    // capacity (last) slot, absorb in chunks of T-1, permute after each chunk.
    let state = [0n, 0n, 0n, DS];
    for (let i = 0; i < inputs.length; i++) state[i] = (state[i] + inputs[i]) % FIELD_MODULUS;
    state = bn254.t4.permutation(state);
    const jsResult = state[0];

    const circomResult = await witnessOutput({ in: inputs.map((x) => x.toString()) }, wasmPath);

    console.log("T=4 sponge — JS reference:", jsResult.toString());
    console.log("T=4 sponge — circom output:", circomResult.toString());
    if (jsResult !== circomResult) {
      console.error("MISMATCH — Poseidon2Sponge(N=3,T=4,DS=1) disagrees with independent JS reference");
      failed = true;
    } else {
      console.log("MATCH\n");
    }
  }
}

// ── T=2 compression mode (used for Merkle-tree hashing) ──
{
  const wasmPath = join(__dirname, "kat_probe_t2_js", "kat_probe_t2.wasm");
  if (!existsSync(wasmPath)) {
    console.log("[SKIP] kat_probe_t2 not compiled — see prerequisite comment above.");
  } else {
    const a = 5n, b = 9n;
    const state = bn254.t2.permutation([a, b]);
    const jsResult = (state[0] + a) % FIELD_MODULUS; // Miyaguchi-Preneel: perm(a,b)[0] + a

    const circomResult = await witnessOutput({ a: a.toString(), b: b.toString() }, wasmPath);

    console.log("T=2 compression — JS reference:", jsResult.toString());
    console.log("T=2 compression — circom output:", circomResult.toString());
    if (jsResult !== circomResult) {
      console.error("MISMATCH — T=2 compression disagrees with independent JS reference");
      failed = true;
    } else {
      console.log("MATCH");
    }
  }
}

if (failed) process.exit(1);
