#!/usr/bin/env node
/**
 * poseidon2-constraint-delta.mjs — R1CS constraint and proving-time delta between circomlib's
 * Poseidon and @taceo/circom-lib's Poseidon2, at the exact hash shapes Veil's circuits use.
 *
 * Compares 4 shape pairs (old = circomlib Poseidon with the domain tag packed into the rate,
 * matching Veil's current circuits; new = a Poseidon2 sponge with the tag moved into the
 * capacity element):
 *   merkle2    - 2 data inputs, no tag   (templates/merkle_proof.circom per-level hash)
 *   recipient2 - 1 data input, tag 8     (withdraw.circom recipient hash)
 *   amount3    - 2 data inputs, tag 3    (transfer.circom txAmountHash)
 *   commit4    - 3 data inputs, tag 1    (transfer.circom/withdraw.circom commitment/nullifier)
 *
 * A 5th shape (compliance.circom's Poseidon(5) credential leaf, 4 data inputs + tag) has no
 * Poseidon2 equivalent here: @taceo/circom-lib's Poseidon2 only supports state sizes
 * t in {2,3,4,8,12,16}, and the sponge equivalent needs t=5. Not measured - see the report.
 *
 * Usage:
 *   node scripts/bench/poseidon2-constraint-delta.mjs [--runs N] [--circom /path/to/circom]
 *
 * Prerequisites:
 *   cd circuits && npm install && npm install --save-dev @taceo/circom-lib
 *   circom 2.2.2+ (required by @taceo/circom-lib's `pragma circom 2.2.2`) - build from
 *   github.com/iden3/circom tag v2.2.2 with `cargo build --release` if no binary is available.
 *   circuits/bench/poseidon2/*.circom - the 8 comparison circuits this script compiles.
 */
import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = join(__dirname, "..", "..", "circuits", "bench", "poseidon2");
const NODE_MODULES = join(__dirname, "..", "..", "circuits", "node_modules");
const BUILD_DIR = join(BENCH_DIR, "build");
const PTAU_FILE = join(BUILD_DIR, "pot10_final.ptau");
const PTAU_URL = "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_10.ptau";

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();
const CIRCOM = (() => {
  const idx = process.argv.indexOf("--circom");
  return idx !== -1 ? process.argv[idx + 1] : "circom";
})();

const SHAPES = [
  { name: "merkle2", old: "old_merkle2", new: "new_merkle2", inputs: { in: ["1", "2"] }, newInputs: { in: ["1", "2"] } },
  { name: "recipient2", old: "old_recipient2", new: "new_recipient2", inputs: { data: "42" }, newInputs: { data: "42" } },
  { name: "amount3", old: "old_amount3", new: "new_amount3", inputs: { data: ["100", "7"] }, newInputs: { data: ["100", "7"] } },
  { name: "commit4", old: "old_commit4", new: "new_commit4", inputs: { data: ["55", "77", "99"] }, newInputs: { data: ["55", "77", "99"] } },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) { return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }

function compile(circuitFile) {
  const cmd = `${CIRCOM} ${circuitFile}.circom --r1cs --wasm --sym --output build -l ${NODE_MODULES}`;
  execSync(cmd, { cwd: BENCH_DIR, stdio: "pipe" });
}

async function setup(circuitFile) {
  const r1cs = join(BUILD_DIR, `${circuitFile}.r1cs`);
  const zkey0 = join(BUILD_DIR, `${circuitFile}_0000.zkey`);
  const zkeyFinal = join(BUILD_DIR, `${circuitFile}_final.zkey`);
  await snarkjs.zKey.newZKey(r1cs, PTAU_FILE, zkey0);
  await snarkjs.zKey.contribute(zkey0, zkeyFinal, "bench", "veil-bench-entropy-" + circuitFile);
  return zkeyFinal;
}

async function proveRuns(circuitFile, input, zkeyFinal, runs) {
  const wasmPath = join(BUILD_DIR, `${circuitFile}_js`, `${circuitFile}.wasm`);
  // warm-up (pays one-time WASM instantiation cost, not counted)
  await snarkjs.groth16.fullProve(input, wasmPath, zkeyFinal);
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    await snarkjs.groth16.fullProve(input, wasmPath, zkeyFinal);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  return times;
}

async function main() {
  mkdirSync(BUILD_DIR, { recursive: true });

  if (!existsSync(PTAU_FILE)) {
    console.log(`Downloading Powers of Tau (pot10) to ${PTAU_FILE} ...`);
    execSync(`curl -L -o "${PTAU_FILE}" "${PTAU_URL}"`, { stdio: "inherit" });
  }

  console.log(`=== Veil Poseidon vs Poseidon2 constraint/proving-time delta (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const rows = [];
  for (const shape of SHAPES) {
    for (const [label, file, input] of [["old", shape.old, shape.inputs], ["new", shape.new, shape.newInputs]]) {
      console.log(`--- compiling ${file} ---`);
      compile(file);
      const r1csInfoRaw = execSync(`npx snarkjs r1cs info build/${file}.r1cs`, { cwd: BENCH_DIR }).toString();
      const constraints = parseInt(r1csInfoRaw.match(/# of Constraints: (\d+)/)[1], 10);
      console.log(r1csInfoRaw.trim());

      console.log(`--- Groth16 setup + proving (${RUNS} runs) for ${file} ---`);
      const zkeyFinal = await setup(file);
      const times = await proveRuns(file, input, zkeyFinal, RUNS);
      const m = mean(times);
      const sd = stddev(times, m);
      console.log(`  mean: ${m.toFixed(3)} ms   stddev: ${sd.toFixed(3)} ms   min: ${Math.min(...times).toFixed(3)} ms   max: ${Math.max(...times).toFixed(3)} ms\n`);

      rows.push({ shape: shape.name, variant: label, file, constraints, meanMs: m, stddevMs: sd });
    }
  }

  console.log("=== Summary ===");
  console.log("shape,variant,file,constraints,mean_ms,stddev_ms");
  for (const r of rows) {
    console.log(`${r.shape},${r.variant},${r.file},${r.constraints},${r.meanMs.toFixed(3)},${r.stddevMs.toFixed(3)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
