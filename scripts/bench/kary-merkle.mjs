#!/usr/bin/env node
/**
 * kary-merkle.mjs — constraints + real Groth16 proving time for the transfer circuit with a
 * binary depth-20 Merkle path (production) vs K-ary paths covering >= 2^20 leaves, plus
 * negative tests (malicious witnesses must fail).
 *
 * Usage: CIRCOM2=/path/to/circom2 node scripts/bench/kary-merkle.mjs [--runs N]
 * Needs: `npm i` in circuits/ and scripts/bench/. Uses a local dev-only ptau (2^15, one
 * contribution) generated on the fly — same trust level as the baseline's dev setup.
 */
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { execFileSync } from "child_process";
import { mkdtempSync, cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildTransferWitness, setPoseidonField, stringifyInputs } from "./witnesses.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CIRC = join(here, "..", "..", "circuits");
const CIRCOM2 = process.env.CIRCOM2 || "circom2";
const RUNS = process.argv.includes("--runs") ? +process.argv[process.argv.indexOf("--runs") + 1] : 10;
const W = mkdtempSync(join(tmpdir(), "kary-"));
mkdirSync(join(W, "experiments")); mkdirSync(join(W, "templates"));
cpSync(join(CIRC, "node_modules"), join(W, "node_modules"), { recursive: true });
cpSync(join(CIRC, "templates"), join(W, "templates"), { recursive: true });
cpSync(join(CIRC, "experiments"), join(W, "experiments"), { recursive: true });
cpSync(join(CIRC, "transfer.circom"), join(W, "transfer.circom"));
mkdirSync(join(W, "out"));

const sh = (cmd, args) => execFileSync(cmd, args, { cwd: W, encoding: "utf8", maxBuffer: 1 << 28 });
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function compile(name, file) {
  const o = sh(CIRCOM2, [file, "--r1cs", "--wasm", "-o", "out"]);
  const nl = +/non-linear constraints: (\d+)/.exec(o)[1], lin = +/(?<!non-)linear constraints: (\d+)/.exec(o)[1];
  return { nl, lin, wasm: join(W, `out/${name}_js/${name}.wasm`), r1cs: join(W, `out/${name}.r1cs`) };
}

async function ptau() {
  const f = join(W, "pot15.ptau");
  await snarkjs.powersOfTau.newAccumulator(await snarkjs.curves.getCurveFromName("bn128"), 15, join(W, "p0.ptau"));
  await snarkjs.powersOfTau.contribute(join(W, "p0.ptau"), join(W, "p1.ptau"), "dev", "bench-entropy");
  await snarkjs.powersOfTau.preparePhase2(join(W, "p1.ptau"), f);
  return f;
}

function karyWitness(poseidon, K, D) {
  const F = poseidon.F, h = (a) => F.toObject(poseidon(a));
  const base = buildTransferWitness(poseidon);
  const sibs = [], onehot = [];
  let node = base.oldCommitment;
  for (let i = 0; i < D; i++) {
    const pos = (i * 3 + 1) % K; // non-degenerate, varying position
    const s = Array.from({ length: K }, (_, j) => BigInt(1000 * (i + 1) + j));
    const oh = Array.from({ length: K }, (_, j) => (j === pos ? 1n : 0n));
    const children = s.map((v, j) => (j === pos ? node : v));
    sibs.push(s); onehot.push(oh);
    node = h(children);
  }
  const { pathElements, pathIndices, ...rest } = base;
  return { ...rest, merkleRoot: node, sibs, onehot };
}

const deepStr = (v) => Array.isArray(v) ? v.map(deepStr) : typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepStr(x)])) : v.toString();
const ok = async (c, zkey, input) => {
  try { await snarkjs.groth16.fullProve(input, c.wasm, zkey); return true; } catch { return false; }
};

async function main() {
  const poseidon = await buildPoseidon(); setPoseidonField(poseidon.F);
  const pot = await ptau();
  const cfgs = [
    { label: "binary d20 (production transfer.circom)", file: "transfer.circom", name: "transfer", prod: true },
    ...[[2, 20], [4, 10], [8, 7], [16, 5]].map(([K, D]) => ({
      label: `${K}-ary d${D} (${K ** D} leaves)`, name: `t${K}`, K, D,
    })),
  ];
  const rows = [];
  for (const c of cfgs) {
    if (!c.prod) {
      const src = readFileSync(join(CIRC, "experiments/transfer_kary.circom"), "utf8")
        .replaceAll("ARITY_PARAM", c.K).replaceAll("DEPTH_PARAM", c.D);
      writeFileSync(join(W, `experiments/${c.name}.circom`), src);
      c.file = `experiments/${c.name}.circom`;
    }
    const m = compile(c.name, c.file);
    const zkey = join(W, `${c.name}.zkey`);
    await snarkjs.zKey.newZKey(m.r1cs, pot, zkey);
    const vk = await snarkjs.zKey.exportVerificationKey(zkey);
    const input = c.prod ? stringifyInputs(buildTransferWitness(poseidon)) : deepStr(karyWitness(poseidon, c.K, c.D));
    await snarkjs.groth16.fullProve(input, m.wasm, zkey); // warm-up
    const ts = []; let proof, pub;
    for (let r = 0; r < RUNS; r++) {
      const t0 = process.hrtime.bigint();
      ({ proof, publicSignals: pub } = await snarkjs.groth16.fullProve(input, m.wasm, zkey));
      ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const verified = await snarkjs.groth16.verify(vk, pub, proof);
    const mean = ts.reduce((a, b) => a + b) / ts.length;
    const sd = Math.sqrt(ts.reduce((s, x) => s + (x - mean) ** 2, 0) / ts.length);
    const row = { label: c.label, nl: m.nl, lin: m.lin, zkey: statSync(zkey).size, mean: mean.toFixed(1), sd: sd.toFixed(1), verified };
    // negative tests (k-ary only)
    if (!c.prod) {
      const w = () => JSON.parse(JSON.stringify(input));
      const bad = {};
      let x = w(); x.sibs[0][(+x.onehot[0].indexOf("1") + 1) % c.K] = "7"; bad["wrong sibling -> root mismatch"] = x;
      x = w(); x.onehot[0] = x.onehot[0].map(() => "1"); bad["all-ones position (sum != 1)"] = x;
      x = w(); x.onehot[0] = x.onehot[0].map(() => "0"); bad["all-zero position"] = x;
      x = w(); const p = x.onehot[0].indexOf("1"); x.onehot[0][p] = "2"; x.onehot[0][(p + 1) % c.K] = (P - 1n).toString(); bad["non-boolean position summing to 1"] = x;
      x = w(); x.sibs[0][x.onehot[0].indexOf("1")] = "999"; // ignored slot: must still VERIFY (documented malleability of dead slot)
      row.neg = {};
      for (const [k, v] of Object.entries(bad)) row.neg[k] = (await ok(m, zkey, v)) ? "ACCEPTED (BUG)" : "rejected";
      row.deadSlotStillAccepted = await ok(m, zkey, x);
    }
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  console.log("\n| config | non-linear | linear | zkey bytes | prove mean ms (σ) | verifies |\n|---|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.label} | ${r.nl} | ${r.lin} | ${r.zkey} | ${r.mean} (${r.sd}) | ${r.verified} |`);
  process.exit(0);
}
main();
