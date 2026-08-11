#!/usr/bin/env node
/**
 * merkle-prove-latency.mjs — head-to-head Groth16 proving benchmark:
 * depth-20 Merkle membership with circomlib Poseidon(2) (c_merkle20, the production
 * template) vs the same structure with Poseidon2 t=3 compression (p2_merkle20).
 *
 * For each of the two circuits: compiles (if needed), runs a real Groth16 setup against
 * the same pot15 ptau the production circuits use, generates + verifies one real proof,
 * then times `snarkjs.groth16.fullProve` (witness generation included) over N runs.
 *
 * Usage:
 *   node scripts/bench/poseidon2/merkle-prove-latency.mjs [--runs N]   (default 10)
 *
 * Prerequisites:
 *   - `circom` on PATH (or CIRCOM=/path/to/circom)
 *   - `cd circuits && npm install`
 *   - circuits/build/pot15_final.ptau (downloaded by circuits/scripts/compile.sh)
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { randomBytes } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");
const require_ = createRequire(join(REPO, "circuits", "package.json"));
const snarkjs = await import(require_.resolve("snarkjs"));

const CIRCOM = process.env.CIRCOM || "circom";
const PTAU = join(REPO, "circuits", "build", "pot15_final.ptau");
const SRC = join(__dirname, "circuits");
const BUILD = join(__dirname, "build");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();

if (!existsSync(PTAU)) {
  console.error(`Missing ${PTAU} — run: cd circuits && bash scripts/compile.sh`);
  process.exit(1);
}

const INCLUDES = [
  join(REPO, "circuits", "node_modules"),
  join(REPO, "circuits", "templates"),
  join(__dirname, "vendor"),
];

// BN254 scalar field modulus.
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const randField = () => (BigInt("0x" + randomBytes(32).toString("hex")) % P).toString();

// Same input shape for both circuits: an arbitrary leaf/path (the circuits output the
// computed root rather than constraining it, so any values exercise every constraint).
const DEPTH = 20;
const input = {
  leaf: randField(),
  pathElements: Array.from({ length: DEPTH }, randField),
  pathIndices: Array.from({ length: DEPTH }, (_, i) => String(i % 2)),
};

async function bench(name) {
  const out = join(BUILD, name);
  mkdirSync(out, { recursive: true });
  const wasm = join(out, `${name}_js`, `${name}.wasm`);
  const r1cs = join(out, `${name}.r1cs`);
  if (!existsSync(wasm) || !existsSync(r1cs)) {
    const args = [join(SRC, `${name}.circom`), "--r1cs", "--wasm", "--output", out];
    for (const inc of INCLUDES) args.push("-l", inc);
    execFileSync(CIRCOM, args, { stdio: "inherit" });
  }

  const zkey = join(out, `${name}.zkey`);
  if (!existsSync(zkey)) {
    console.log(`[setup] groth16 setup for ${name} (bench-only zkey, no ceremony)...`);
    await snarkjs.zKey.newZKey(r1cs, PTAU, zkey);
  }

  // Correctness sanity check: one proof must verify before we time anything.
  const vk = await snarkjs.zKey.exportVerificationKey(zkey);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) {
    throw new Error(`${name}: proof failed verification — aborting benchmark`);
  }

  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    await snarkjs.groth16.fullProve(input, wasm, zkey);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const sd = Math.sqrt(times.reduce((a, b) => a + (b - mean) ** 2, 0) / times.length);
  console.log(`--- ${name} ---`);
  console.log(`  runs: ${RUNS}`);
  console.log(
    `  mean: ${mean.toFixed(2)} ms   stddev: ${sd.toFixed(2)} ms   min: ${Math.min(...times).toFixed(2)} ms   max: ${Math.max(...times).toFixed(2)} ms`
  );
  console.log(`  root (public output): ${publicSignals[0]}`);
  return mean;
}

console.log(`=== Depth-20 Merkle proof: circomlib Poseidon vs Poseidon2 (t=3) — ${RUNS} runs each ===`);
console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);
const a = await bench("c_merkle20");
const b = await bench("p2_merkle20");
console.log(`\nPoseidon2 / Poseidon mean ratio: ${(b / a).toFixed(3)}x`);

process.exit(0);
