#!/usr/bin/env node
/**
 * bench.mjs — Merkle hash / arity experiment (docs/research/2026-11-14-poseidon2-merkle-arity.md).
 *
 * Compares, on one machine, in one run:
 *   1. Merkle membership alone (depth chosen for 2^20 leaves):
 *        bin_poseidon_d20   — production shape: binary, circomlib Poseidon(2), depth 20
 *        bin_poseidon2_d20  — binary, Poseidon2 t=3 (HorizenLabs BN254 params), depth 20
 *        quad_poseidon_d10  — 4-ary, circomlib Poseidon(4) (t=5), depth 10
 *   2. Full production circuits vs. generated variants (derived from circuits/*.circom by text
 *      substitution at bench time, so they track the production source):
 *        transfer            — circuits/transfer.circom unchanged
 *        transfer_quad       — membership swapped to 4-ary depth 10
 *        transfer_nomerkle   — membership removed (cost of C0 alone; see report §Finding)
 *        compliance          — circuits/compliance.circom unchanged
 *        compliance_quad     — credential tree swapped to 4-ary depth 10
 *
 * For each: R1CS stats at circom -O1 (production default) and -O2, Groth16 setup, N timed
 * fullProve runs (witness gen + prove, after one warm-up), verify every proof.
 *
 * Usage:
 *   node scripts/bench/hash-arity/bench.mjs --ptau /path/pot14_final.ptau [--runs 10] [--prove-opt O1|O2] [--only a,b]
 *
 * Prerequisites: circom 2.2.x on PATH, `npm ci` in circuits/ and scripts/bench/,
 * a prepared pot14 (or larger) ptau. A dev-only one can be generated locally:
 *   snarkjs powersoftau new bn128 14 p0.ptau
 *   snarkjs powersoftau contribute p0.ptau p1.ptau --name=bench -e="<entropy>"
 *   snarkjs powersoftau prepare phase2 p1.ptau pot14_final.ptau
 */
import { execFileSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import os from "os";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "../witnesses.mjs";
import { hash2 as p2hash2 } from "./poseidon2.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..", "..");
const CIRCUITS = join(ROOT, "circuits");
const LIB = join(CIRCUITS, "node_modules");
const BUILD = join(here, "build");
const GEN = join(BUILD, "gen");

const arg = (k, d) => { const i = process.argv.indexOf(k); return i === -1 ? d : process.argv[i + 1]; };
const RUNS = parseInt(arg("--runs", "10"), 10);
const PTAU = arg("--ptau", null);
const ONLY = arg("--only", null);
const PROVE_OPT = arg("--prove-opt", "O1"); // which compiled R1CS (O1 = production default) gets set up + proved
if (!["O1", "O2"].includes(PROVE_OPT)) { console.error("--prove-opt must be O1 or O2"); process.exit(1); }
if (!PTAU || !existsSync(PTAU)) { console.error("--ptau <prepared ptau> required"); process.exit(1); }

const silent = { debug() {}, info() {}, warn() {}, error: console.error, log() {} };

// ─── deterministic randomness (reproducible witnesses) ───────────────────────
let seed = 0x9e3779b97f4a7c15n;
function rnd() { // xorshift64* → 248-bit field-ish element
  let out = 0n;
  for (let k = 0; k < 4; k++) {
    seed ^= seed << 13n; seed &= (1n << 64n) - 1n;
    seed ^= seed >> 7n;
    seed ^= seed << 17n; seed &= (1n << 64n) - 1n;
    out = (out << 62n) | (seed & ((1n << 62n) - 1n));
  }
  return out;
}

// ─── generated production variants ───────────────────────────────────────────
const QUAD_INCLUDE = `include "${join(here, "circuits", "merkle_variants.circom")}";`;
function genTransfer(kind) {
  let s = readFileSync(join(CIRCUITS, "transfer.circom"), "utf8");
  const blockRe = /component membershipProof = MerkleProof\(20\);[\s\S]*?merkleRoot === membershipProof\.root;/;
  if (!blockRe.test(s)) throw new Error("transfer.circom membership block not found — update genTransfer()");
  if (kind === "quad") {
    s = s.replace('include "templates/merkle_proof.circom";', QUAD_INCLUDE)
      .replace("signal input pathElements[20];", "signal input pathElements[10][3];")
      .replace("signal input pathIndices[20];", "signal input pathIndices[10][2];")
      .replace(blockRe, `component membershipProof = MerkleQuadPoseidon(10);
    membershipProof.leaf <== oldCommitment;
    for (var i = 0; i < 10; i++) {
        for (var j = 0; j < 3; j++) membershipProof.pathElements[i][j] <== pathElements[i][j];
        membershipProof.pathIndices[i][0] <== pathIndices[i][0];
        membershipProof.pathIndices[i][1] <== pathIndices[i][1];
    }
    merkleRoot === membershipProof.root;`);
  } else if (kind === "nomerkle") {
    // merkleRoot stays a public input (same public-input layout), constrained trivially.
    s = s.replace("signal input pathElements[20];", "")
      .replace("signal input pathIndices[20];", "")
      .replace(blockRe, "signal rootSq; rootSq <== merkleRoot * merkleRoot;");
  }
  return s;
}
function genComplianceQuad() {
  let s = readFileSync(join(CIRCUITS, "compliance.circom"), "utf8");
  const blockRe = /component merkleProof = MerkleProof\(merkleDepth\);([\s\S]*?)for \(var i = 0; i < merkleDepth; i\+\+\) \{\s*merkleProof\.pathElements\[i\] <== pathElements\[i\];\s*merkleProof\.pathIndices\[i\] <== pathIndices\[i\];\s*\}/;
  if (!blockRe.test(s)) throw new Error("compliance.circom membership block not found — update genComplianceQuad()");
  return s.replace('include "templates/merkle_proof.circom";', QUAD_INCLUDE)
    .replace("signal input pathElements[merkleDepth];", "signal input pathElements[merkleDepth][3];")
    .replace("signal input pathIndices[merkleDepth];", "signal input pathIndices[merkleDepth][2];")
    .replace(blockRe, (_m, mid) => `component merkleProof = MerkleQuadPoseidon(merkleDepth);${mid}for (var i = 0; i < merkleDepth; i++) {
        for (var j = 0; j < 3; j++) merkleProof.pathElements[i][j] <== pathElements[i][j];
        merkleProof.pathIndices[i][0] <== pathIndices[i][0];
        merkleProof.pathIndices[i][1] <== pathIndices[i][1];
    }`)
    .replace("= Compliance(20);", "= Compliance(10);");
}

// ─── witness builders ────────────────────────────────────────────────────────
let poseidon, F;
const P = (xs) => F.toObject(poseidon(xs));
function binaryPath(leaf, depth, hash) {
  const pathElements = [], pathIndices = [];
  let node = leaf;
  for (let i = 0; i < depth; i++) {
    const sib = rnd(), bit = rnd() & 1n;
    pathElements.push(sib); pathIndices.push(bit);
    node = bit === 0n ? hash(node, sib) : hash(sib, node);
  }
  return { root: node, pathElements, pathIndices };
}
export function quadPath(leaf, depth, positions) {
  const pathElements = [], pathIndices = [];
  let node = leaf;
  for (let i = 0; i < depth; i++) {
    const sibs = [rnd(), rnd(), rnd()];
    const p = positions ? positions[i] : Number(rnd() & 3n);
    const kids = [...sibs]; kids.splice(p, 0, node);
    pathElements.push(sibs); pathIndices.push([BigInt(p & 1), BigInt(p >> 1)]);
    node = P(kids);
  }
  return { root: node, pathElements, pathIndices };
}
const ph2 = (a, b) => P([a, b]);

const WITNESS = {
  bin_poseidon_d20() { const leaf = rnd(); const t = binaryPath(leaf, 20, ph2); return { leaf, ...t }; },
  bin_poseidon2_d20() { const leaf = rnd(); const t = binaryPath(leaf, 20, p2hash2); return { leaf, ...t }; },
  quad_poseidon_d10() { const leaf = rnd(); const t = quadPath(leaf, 10); return { leaf, ...t }; },
  transfer() {
    const w = WITNESS_BUILDERS.transfer(poseidon);
    const t = binaryPath(w.oldCommitment, 20, ph2);
    return { ...w, merkleRoot: t.root, pathElements: t.pathElements, pathIndices: t.pathIndices };
  },
  transfer_quad() {
    const w = WITNESS_BUILDERS.transfer(poseidon);
    const t = quadPath(w.oldCommitment, 10);
    return { ...w, merkleRoot: t.root, pathElements: t.pathElements, pathIndices: t.pathIndices };
  },
  transfer_nomerkle() {
    const w = WITNESS_BUILDERS.transfer(poseidon);
    delete w.pathElements; delete w.pathIndices;
    return w;
  },
  compliance() {
    const w = WITNESS_BUILDERS.compliance(poseidon);
    const leaf = P([4n, w.userSecret, w.kycLevel, w.expiryEpoch, w.issuerId]);
    const t = binaryPath(leaf, 20, ph2);
    return { ...w, merkleRoot: t.root, pathElements: t.pathElements, pathIndices: t.pathIndices };
  },
  compliance_quad() {
    const w = WITNESS_BUILDERS.compliance(poseidon);
    const leaf = P([4n, w.userSecret, w.kycLevel, w.expiryEpoch, w.issuerId]);
    const t = quadPath(leaf, 10);
    return { ...w, merkleRoot: t.root, pathElements: t.pathElements, pathIndices: t.pathIndices };
  },
};
// membership circuits name their public root `root`
for (const k of ["bin_poseidon_d20", "bin_poseidon2_d20", "quad_poseidon_d10"]) {
  const f = WITNESS[k];
  WITNESS[k] = () => { const w = f(); return { root: w.root, leaf: w.leaf, pathElements: w.pathElements, pathIndices: w.pathIndices }; };
}

export function stringify(v) {
  if (Array.isArray(v)) return v.map(stringify);
  return typeof v === "bigint" || typeof v === "number" ? v.toString() : v;
}
const strIn = (w) => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, stringify(v)]));

// ─── compile + setup ─────────────────────────────────────────────────────────
function circomCompile(src, name, opt) {
  const out = join(BUILD, opt);
  mkdirSync(out, { recursive: true });
  const log = execFileSync("circom", [src, "--r1cs", "--wasm", `--${opt}`, "-l", LIB, "-l", CIRCUITS, "-l", join(here, "circuits"), "-o", out], { encoding: "utf8" });
  const g = (re) => parseInt((log.match(re) || [])[1] ?? "NaN", 10);
  return {
    nonLinear: g(/non-linear constraints: (\d+)/), linear: g(/(?<!non-)linear constraints: (\d+)/),
    wires: g(/wires: (\d+)/), publicInputs: g(/public inputs: (\d+)/), privateInputs: g(/private inputs: (\d+)/),
    r1cs: join(out, `${name}.r1cs`), wasm: join(out, `${name}_js`, `${name}.wasm`), log,
  };
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };

async function main() {
  poseidon = await buildPoseidon(); F = poseidon.F; setPoseidonField(F);
  mkdirSync(GEN, { recursive: true });
  writeFileSync(join(GEN, "transfer_quad.circom"), genTransfer("quad"));
  writeFileSync(join(GEN, "transfer_nomerkle.circom"), genTransfer("nomerkle"));
  writeFileSync(join(GEN, "compliance_quad.circom"), genComplianceQuad());

  const TARGETS = [
    ["bin_poseidon_d20", join(here, "circuits", "bin_poseidon_d20.circom")],
    ["bin_poseidon2_d20", join(here, "circuits", "bin_poseidon2_d20.circom")],
    ["quad_poseidon_d10", join(here, "circuits", "quad_poseidon_d10.circom")],
    ["transfer", join(CIRCUITS, "transfer.circom")],
    ["transfer_quad", join(GEN, "transfer_quad.circom")],
    ["transfer_nomerkle", join(GEN, "transfer_nomerkle.circom")],
    ["compliance", join(CIRCUITS, "compliance.circom")],
    ["compliance_quad", join(GEN, "compliance_quad.circom")],
  ].filter(([n]) => !ONLY || ONLY.split(",").includes(n));

  console.log(`=== Veil Merkle hash/arity benchmark (${RUNS} timed runs per circuit, proving the -${PROVE_OPT} R1CS) ===`);
  console.log(`node ${process.version}, ${os.platform()}/${os.arch()}, ${os.cpus().length}x ${os.cpus()[0].model}`);
  console.log(`circom: ${execFileSync("circom", ["--version"], { encoding: "utf8" }).trim()}, ptau: ${PTAU}\n`);

  const results = [];
  for (const [name, src] of TARGETS) {
    const o2 = circomCompile(src, name, "O2");
    const o1 = circomCompile(src, name, "O1");
    const pc = PROVE_OPT === "O1" ? o1 : o2;
    const zkey = join(BUILD, PROVE_OPT, `${name}.zkey`);
    await snarkjs.zKey.newZKey(pc.r1cs, PTAU, join(BUILD, PROVE_OPT, `${name}_0.zkey`), silent);
    await snarkjs.zKey.contribute(join(BUILD, PROVE_OPT, `${name}_0.zkey`), zkey, "bench", `bench-${name}`, silent);
    const vk = await snarkjs.zKey.exportVerificationKey(zkey, silent);

    const input = strIn(WITNESS[name]());
    const warm = await snarkjs.groth16.fullProve(input, pc.wasm, zkey);
    let allValid = await snarkjs.groth16.verify(vk, warm.publicSignals, warm.proof);
    const times = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, pc.wasm, zkey);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      allValid = allValid && await snarkjs.groth16.verify(vk, publicSignals, proof);
    }
    const r = {
      name, provedAt: PROVE_OPT, O1: { nonLinear: o1.nonLinear, linear: o1.linear, wires: o1.wires },
      O2: { nonLinear: o2.nonLinear, linear: o2.linear, wires: o2.wires },
      inputs: `${o1.publicInputs} pub / ${o1.privateInputs} priv`, zkeyBytes: statSync(zkey).size,
      proveMeanMs: +mean(times).toFixed(1), proveSdMs: +sd(times).toFixed(1),
      minMs: +Math.min(...times).toFixed(1), maxMs: +Math.max(...times).toFixed(1), runs: RUNS, allProofsVerify: allValid,
    };
    results.push(r);
    console.log(`--- ${name} ---`);
    console.log(`  O1: non-linear ${r.O1.nonLinear}, linear ${r.O1.linear}, wires ${r.O1.wires} | O2: non-linear ${r.O2.nonLinear}, linear ${r.O2.linear}, wires ${r.O2.wires} | ${r.inputs}`);
    console.log(`  zkey ${r.zkeyBytes} B | prove mean ${r.proveMeanMs} ms  sd ${r.proveSdMs}  min ${r.minMs}  max ${r.maxMs} (${RUNS} runs) | all proofs verify: ${allValid}\n`);
  }
  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
