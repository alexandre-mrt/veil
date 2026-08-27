#!/usr/bin/env node
/**
 * poseidon2-full-circuit.mjs — full-circuit R1CS constraint and Groth16 proving-time delta
 * between Veil's production circuits and their Poseidon2 variants
 * (circuits/bench/poseidon2/full/{transfer,withdraw,compliance}_v2.circom).
 *
 * Compiles both the original circuits (circuits/{transfer,withdraw,compliance}.circom) and the
 * v2 variants, runs a real (dev, single-contributor) Groth16 setup for each with the same pot15
 * ptau the rest of the repo uses, and times snarkjs.groth16.fullProve over real witnesses built
 * from scripts/bench/witnesses.mjs (old) and witnesses-v2.mjs (new) - the same fixtures, so this
 * is an apples-to-apples proving-time comparison at Veil's actual circuit scale.
 *
 * Usage:
 *   node scripts/bench/poseidon2-full-circuit.mjs [--runs N] [--circom /path/to/circom]
 */
import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "./witnesses.mjs";
import { buildTransferWitnessV2, buildWithdrawWitnessV2, buildComplianceWitnessV2, stringifyInputs as stringifyV2 } from "./witnesses-v2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
const V2_DIR = join(CIRCUITS_DIR, "bench", "poseidon2", "full");
const OLD_BUILD = join(V2_DIR, "build-old");
const NEW_BUILD = join(V2_DIR, "build");
const PTAU_FILE = join(V2_DIR, "pot15_final.ptau");
const PTAU_URL = "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau";
const NODE_MODULES = join(CIRCUITS_DIR, "node_modules");

const RUNS = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 10;
})();
const CIRCOM = (() => {
  const idx = process.argv.indexOf("--circom");
  return idx !== -1 ? process.argv[idx + 1] : "circom";
})();

const PAIRS = [
  { name: "transfer", oldFile: "transfer", oldSrc: CIRCUITS_DIR, newFile: "transfer_v2" },
  { name: "withdraw", oldFile: "withdraw", oldSrc: CIRCUITS_DIR, newFile: "withdraw_v2" },
  { name: "compliance", oldFile: "compliance", oldSrc: CIRCUITS_DIR, newFile: "compliance_v2" },
];

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr, m) { return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }

function compile(srcDir, file, outDir) {
  execSync(`${CIRCOM} ${file}.circom --r1cs --wasm --sym --output ${outDir} -l ${NODE_MODULES}`, { cwd: srcDir, stdio: "pipe" });
}

async function setup(outDir, file) {
  const r1cs = join(outDir, `${file}.r1cs`);
  const zkey0 = join(outDir, `${file}_0000.zkey`);
  const zkeyFinal = join(outDir, `${file}_final.zkey`);
  await snarkjs.zKey.newZKey(r1cs, PTAU_FILE, zkey0);
  await snarkjs.zKey.contribute(zkey0, zkeyFinal, "bench", "veil-bench-entropy-" + file);
  return zkeyFinal;
}

async function proveRuns(outDir, file, input, zkeyFinal, runs) {
  const wasmPath = join(outDir, `${file}_js`, `${file}.wasm`);
  await snarkjs.groth16.fullProve(input, wasmPath, zkeyFinal); // warm-up
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
  mkdirSync(OLD_BUILD, { recursive: true });
  mkdirSync(NEW_BUILD, { recursive: true });

  if (!existsSync(PTAU_FILE)) {
    console.log(`Downloading Powers of Tau (pot15, ~85MB) to ${PTAU_FILE} ...`);
    execSync(`curl -L -o "${PTAU_FILE}" "${PTAU_URL}"`, { stdio: "inherit" });
  }

  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);

  const witnessBuildersV2 = {
    transfer: () => stringifyV2(buildTransferWitnessV2()),
    withdraw: () => stringifyV2(buildWithdrawWitnessV2()),
    compliance: () => stringifyV2(buildComplianceWitnessV2(poseidon, poseidon.F)),
  };

  console.log(`=== Veil full-circuit Poseidon vs Poseidon2 delta (${RUNS} runs per circuit) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}\n`);

  const rows = [];
  for (const pair of PAIRS) {
    for (const variant of ["old", "new"]) {
      const isOld = variant === "old";
      const srcDir = isOld ? pair.oldSrc : V2_DIR;
      const file = isOld ? pair.oldFile : pair.newFile;
      const outDir = isOld ? OLD_BUILD : NEW_BUILD;

      console.log(`--- compiling ${file} (${variant}) ---`);
      compile(srcDir, file, outDir);
      const r1csInfoRaw = execSync(`npx snarkjs r1cs info ${join(outDir, file + ".r1cs")}`, { cwd: V2_DIR }).toString();
      const constraints = parseInt(r1csInfoRaw.match(/# of Constraints: (\d+)/)[1], 10);
      console.log(r1csInfoRaw.trim());

      console.log(`--- Groth16 setup + proving (${RUNS} runs) for ${file} ---`);
      const zkeyFinal = await setup(outDir, file);
      const input = isOld ? stringifyInputs(WITNESS_BUILDERS[pair.name](poseidon)) : witnessBuildersV2[pair.name]();
      const times = await proveRuns(outDir, file, input, zkeyFinal, RUNS);
      const m = mean(times);
      const sd = stddev(times, m);
      console.log(`  mean: ${m.toFixed(2)} ms   stddev: ${sd.toFixed(2)} ms   min: ${Math.min(...times).toFixed(2)} ms   max: ${Math.max(...times).toFixed(2)} ms\n`);

      rows.push({ circuit: pair.name, variant, file, constraints, meanMs: m, stddevMs: sd });
    }
  }

  console.log("=== Summary ===");
  console.log("circuit,variant,file,constraints,mean_ms,stddev_ms");
  for (const r of rows) {
    console.log(`${r.circuit},${r.variant},${r.file},${r.constraints},${r.meanMs.toFixed(2)},${r.stddevMs.toFixed(2)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
