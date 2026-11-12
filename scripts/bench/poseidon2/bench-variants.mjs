#!/usr/bin/env node
/**
 * bench-variants.mjs — Poseidon vs Poseidon2 Merkle hasher, measured end to end.
 *
 * For each of transfer / compliance it builds two circuits that differ ONLY in the 2-to-1 hasher
 * of the depth-20 Merkle membership proof:
 *   <name>     — the production circuit as-is (circomlib Poseidon(2), via templates/merkle_proof.circom)
 *   <name>_p2  — same file with MerkleProof -> MerkleProofP2 (research/merkle_proof_p2.circom,
 *                Poseidon2 t=3 from research/poseidon2.circom)
 * and measures: R1CS constraints (circom's own report, project-default -O1), Groth16 zkey / vk
 * size, Node proving time (snarkjs fullProve = witness + prove; warm-up excluded), and checks the
 * proof verifies. Also records compile-only constraint counts under --O2 as context.
 *
 * Usage:
 *   node scripts/bench/poseidon2/bench-variants.mjs --ptau <pot15_final.ptau> [--runs 10] [--out DIR]
 * Prerequisites: circom 2.2.x on PATH; `npm ci` in circuits/ and scripts/bench/.
 * Note: the Hermez pot15 URL in circuits/scripts/compile.sh returned HTTP 403 on 2026-11-12; a
 * locally generated pot15 (snarkjs powersoftau new/contribute/prepare phase2) is equivalent for
 * timing and size purposes (same curve, same 2^15 size) — never for production.
 */
import { execFileSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir, cpus } from "os";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "../witnesses.mjs";
import { hash2 } from "./poseidon2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS = join(__dirname, "..", "..", "..", "circuits");
const SNARKJS = join(CIRCUITS, "node_modules", ".bin", "snarkjs");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i === -1 ? d : process.argv[i + 1]; };
const RUNS = parseInt(arg("--runs", "10"), 10);
const PTAU = arg("--ptau", join(CIRCUITS, "build", "pot15_final.ptau"));
const OUT = arg("--out", join(tmpdir(), "veil-p2-bench"));
mkdirSync(OUT, { recursive: true });

const VARIANTS = [
  { name: "transfer", base: "transfer", p2: false },
  { name: "transfer_p2", base: "transfer", p2: true },
  { name: "compliance", base: "compliance", p2: false },
  { name: "compliance_p2", base: "compliance", p2: true },
];

function source(v) {
  let s = readFileSync(join(CIRCUITS, `${v.base}.circom`), "utf8");
  if (v.p2) {
    s = s.replace('include "templates/merkle_proof.circom";', 'include "research/merkle_proof_p2.circom";');
    s = s.replace(/= MerkleProof\(/g, "= MerkleProofP2(");
    if (!s.includes("MerkleProofP2(")) throw new Error(`substitution failed for ${v.name}`);
  }
  const f = join(OUT, `${v.name}.circom`);
  writeFileSync(f, s);
  return f;
}

function compile(v, extra = []) {
  const dir = join(OUT, extra.length ? `${v.name}-${extra.join("")}` : v.name);
  mkdirSync(dir, { recursive: true });
  const log = execFileSync("circom", [source(v), "--r1cs", "--wasm", "-l", CIRCUITS, "--output", dir, ...extra], { encoding: "utf8" });
  const num = (re) => parseInt((log.match(re) || [])[1], 10);
  return {
    dir, log,
    nonLinear: num(/non-linear constraints: (\d+)/), linear: num(/^linear constraints: (\d+)/m),
    wires: num(/wires: (\d+)/),
  };
}

const sn = (...a) => execFileSync(SNARKJS, a, { encoding: "utf8" });

// Witness builders call poseidon([...]); in transfer/compliance every arity-2 call is a Merkle
// node, so the P2 variant routes arity-2 calls to Poseidon2 and leaves the rest on Poseidon.
function hasherFor(v, poseidon) {
  if (!v.p2) return poseidon;
  return (xs) => (xs.length === 2 ? hash2(BigInt(xs[0]), BigInt(xs[1])) : poseidon(xs));
}

// Number of non-zero A/B matrix coefficients stored in the zkey (what groth16.prove multiplies
// through on every proof to build A.w and B.w before the FFTs).
function zkeyCoefs(zk) {
  const j = zk + ".json";
  sn("zkey", "export", "json", zk, j);
  const d = JSON.parse(readFileSync(j, "utf8"));
  return d.ccoefs.length;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a, m) => Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  console.log(`=== Poseidon vs Poseidon2 Merkle hasher — ${RUNS} proving runs/variant ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}, ${cpus().length}x ${cpus()[0].model}`);
  console.log(execFileSync("circom", ["--version"], { encoding: "utf8" }).trim(), `| ptau ${PTAU}\n`);

  const rows = [];
  for (const v of VARIANTS) {
    const c = compile(v);
    const o2 = compile(v, ["--O2"]);
    const r1cs = join(c.dir, `${v.name}.r1cs`);
    const z0 = join(c.dir, `${v.name}_0000.zkey`), zk = join(c.dir, `${v.name}_final.zkey`), vkf = join(c.dir, `${v.name}_vk.json`);
    sn("groth16", "setup", r1cs, PTAU, z0);
    execFileSync(SNARKJS, ["zkey", "contribute", z0, zk, "--name=bench", "-e=bench-entropy"], { encoding: "utf8" });
    sn("zkey", "export", "verificationkey", zk, vkf);
    const info = sn("r1cs", "info", r1cs);

    const wasm = join(c.dir, `${v.name}_js`, `${v.name}.wasm`);
    const inputs = stringifyInputs(WITNESS_BUILDERS[v.base](hasherFor(v, poseidon)));
    const vk = JSON.parse(readFileSync(vkf, "utf8"));
    const warm = await snarkjs.groth16.fullProve(inputs, wasm, zk);
    const ok = await snarkjs.groth16.verify(vk, warm.publicSignals, warm.proof);
    const t = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      await snarkjs.groth16.fullProve(inputs, wasm, zk);
      t.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    // Split timing: witness generation alone vs groth16.prove alone (same inputs, same zkey).
    const tw = [], tp = [];
    for (let i = 0; i < RUNS; i++) {
      const wtns = { type: "mem" };
      const a = process.hrtime.bigint();
      await snarkjs.wtns.calculate(inputs, wasm, wtns);
      const b = process.hrtime.bigint();
      await snarkjs.groth16.prove(zk, wtns);
      const c2 = process.hrtime.bigint();
      tw.push(Number(b - a) / 1e6); tp.push(Number(c2 - b) / 1e6);
    }
    const m = mean(t);
    const row = {
      variant: v.name, nonLinear: c.nonLinear, linear: c.linear, total: c.nonLinear + c.linear, wires: c.wires,
      o2NonLinear: o2.nonLinear, o2Linear: o2.linear, o2Total: o2.nonLinear + o2.linear,
      zkeyBytes: statSync(zk).size, vkBytes: statSync(vkf).size, wasmBytes: statSync(wasm).size,
      verifies: ok, runs: RUNS, meanMs: +m.toFixed(1), sdMs: +sd(t, m).toFixed(1),
      minMs: +Math.min(...t).toFixed(1), maxMs: +Math.max(...t).toFixed(1),
      witnessMeanMs: +mean(tw).toFixed(1), proveOnlyMeanMs: +mean(tp).toFixed(1), proveOnlySdMs: +sd(tp, mean(tp)).toFixed(1),
      abcCoefs: zkeyCoefs(zk),
    };
    rows.push(row);
    console.log(`--- ${v.name} ---`);
    console.log(info.trim().split("\n").filter((l) => /Constraints|Wires|Inputs|Outputs/.test(l)).join("\n"));
    console.log(`  circom -O1: non-linear ${c.nonLinear}, linear ${c.linear}, wires ${c.wires} | --O2: non-linear ${o2.nonLinear}, linear ${o2.linear}`);
    console.log(`  zkey ${row.zkeyBytes} B, vk ${row.vkBytes} B, wasm ${row.wasmBytes} B, proof verifies: ${ok}`);
    console.log(`  split: witness ${row.witnessMeanMs} ms + groth16.prove ${row.proveOnlyMeanMs} ms (sd ${row.proveOnlySdMs}); A/B coefficients in zkey: ${row.abcCoefs}`);
    console.log(`  prove: mean ${row.meanMs} ms, sd ${row.sdMs}, min ${row.minMs}, max ${row.maxMs} (${RUNS} runs)\n`);
  }
  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(rows, null, 1));
  process.exit(0); // snarkjs leaves worker threads alive (see LEDGER 2026-07-22, queue item 12)
}
main().catch((e) => { console.error(e); process.exit(1); });
