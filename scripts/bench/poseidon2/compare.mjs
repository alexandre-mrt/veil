#!/usr/bin/env node
// compare.mjs — baseline (circomlib Poseidon Merkle node) vs Poseidon2-t3 Merkle node variant.
// Usage (from repo root, after `bash scripts/bench/poseidon2/run.sh` has built artifacts):
//   node scripts/bench/poseidon2/compare.mjs --runs 10
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { statSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "../witnesses.mjs";
import { compress } from "./poseidon2.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const B = join(here, "..", "..", "..", "circuits", "build-p2");
const SJ = join(here, "..", "..", "..", "circuits", "node_modules", ".bin", "snarkjs");
const RUNS = (() => { const i = process.argv.indexOf("--runs"); return i !== -1 ? +process.argv[i + 1] : 10; })();
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };

const poseidon = await buildPoseidon();
setPoseidonField(poseidon.F);
const toBI = (v) => (typeof v === "bigint" ? v : poseidon.F.toObject(v));
// Hybrid hash: circomlib Poseidon everywhere except the 2-input call, which in transfer/compliance
// witnesses is exclusively the Merkle node hash -> Poseidon2 compress.
const hybrid = (xs) => (xs.length === 2 ? compress(toBI(xs[0]), toBI(xs[1])) : poseidon(xs));

const variants = [
  { circuit: "transfer", variant: "baseline", dir: join(B, "base"), hash: poseidon },
  { circuit: "transfer", variant: "poseidon2-merkle", dir: B, hash: hybrid },
  { circuit: "compliance", variant: "baseline", dir: join(B, "base"), hash: poseidon },
  { circuit: "compliance", variant: "poseidon2-merkle", dir: B, hash: hybrid },
];

const sh = (...a) => execFileSync(SJ, a, { stdio: "pipe" }).toString();
const rows = [];
for (const v of variants) {
  const r1cs = join(v.dir, `${v.circuit}.r1cs`), wasm = join(v.dir, `${v.circuit}_js`, `${v.circuit}.wasm`);
  const tag = `${v.circuit}-${v.variant}`;
  const z0 = join(B, `${tag}_0.zkey`), zf = join(B, `${tag}.zkey`), vkf = join(B, `${tag}.vk.json`);
  if (!existsSync(zf)) {
    sh("groth16", "setup", r1cs, join(B, "pot15.ptau"), z0);
    sh("zkey", "contribute", z0, zf, "--name=dev", "-e=veil-bench-dev-only");
    sh("zkey", "export", "verificationkey", zf, vkf);
  }
  const vk = JSON.parse(readFileSync(vkf, "utf8"));
  const info = sh("r1cs", "info", r1cs);
  const inputs = stringifyInputs(WITNESS_BUILDERS[v.circuit](v.hash));
  const warm = await snarkjs.groth16.fullProve(inputs, wasm, zf);
  const ok = await snarkjs.groth16.verify(vk, warm.publicSignals, warm.proof);
  const t = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    await snarkjs.groth16.fullProve(inputs, wasm, zf);
    t.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const num = (re) => +info.match(re)[1];
  // negative test: wrong Merkle root must be rejected at witness generation
  let rejected = false;
  try { await snarkjs.groth16.fullProve({ ...inputs, merkleRoot: "12345" }, wasm, zf); } catch { rejected = true; }
  // negative test: flip a path index bit (valid boolean, wrong path) must be rejected
  let rejectedPath = false;
  try { const bad = { ...inputs, pathIndices: inputs.pathIndices.map((x, i) => (i === 3 ? "1" : x)) };
    await snarkjs.groth16.fullProve(bad, wasm, zf); } catch { rejectedPath = true; }
  rows.push({ circuit: v.circuit, variant: v.variant,
    constraints: num(/# of Constraints: (\d+)/), wires: num(/# of Wires: (\d+)/),
    zkeyBytes: statSync(zf).size, verifies: ok, rejectsBadRoot: rejected, rejectsBadPath: rejectedPath,
    proveMs: +mean(t).toFixed(1), sdMs: +sd(t).toFixed(1), runs: RUNS });
  console.log(JSON.stringify(rows.at(-1)));
}
console.log("\n| circuit | variant | constraints | wires | zkey bytes | prove ms (mean, σ) | verifies | neg: bad root | neg: bad path |\n|---|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.circuit} | ${r.variant} | ${r.constraints} | ${r.wires} | ${r.zkeyBytes} | ${r.proveMs} (σ ${r.sdMs}, n=${r.runs}) | ${r.verifies} | ${r.rejectsBadRoot} | ${r.rejectsBadPath} |`);
process.exit(0);
