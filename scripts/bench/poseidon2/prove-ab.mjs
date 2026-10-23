#!/usr/bin/env node
/** prove-ab.mjs — Node Groth16 fullProve timing for base (circomlib) vs p2 (Poseidon2 shim) builds made by run.sh. */
import { buildPoseidon } from "circomlibjs";
import { join } from "path";
import * as snarkjs from "snarkjs";
import { permute, F1Field, Poseidon2, getPoseidon2Params } from "@zkpassport/poseidon2";
import { readFileSync, existsSync } from "fs";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "../witnesses.mjs";

const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const RUNS = parseInt(arg("--runs", "10"), 10);
const WORK = process.env.WORK;
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const F = new F1Field(P);
const hexes = (s) => [...s.matchAll(/0x[0-9a-fA-F]{64}/g)].map((m) => BigInt(m[0]));
const rs = readFileSync(process.env.HORIZEN_RS, "utf8");
const flat = hexes(rs.slice(rs.indexOf("RC3"), rs.indexOf("POSEIDON2_BN256_PARAMS")));
const rc3 = Array.from({ length: 64 }, (_, r) => flat.slice(r * 3, r * 3 + 3));
const diag3 = hexes(rs.slice(rs.indexOf("MAT_DIAG3_M_1"), rs.indexOf("MAT_INTERNAL3")));
const p3 = new Poseidon2(getPoseidon2Params(3, 5, 8, 56, diag3, [], rc3), F);

// JS mirror of poseidon2.circom's `Poseidon(n)` shim (capacity lane0 = n, rate lanes 1.., out = lane 1).
function p2hash(inputs) {
  const n = inputs.length, T = n <= 2 ? 3 : 4, rate = T - 1;
  const perm = T === 3 ? (s) => p3.permute(s) : (s) => permute(s);
  let st = Array(T).fill(0n); st[0] = BigInt(n);
  for (let off = 0; off < n; off += rate) {
    for (let i = 0; i < rate && off + i < n; i++) st[1 + i] = F.add(st[1 + i], BigInt(inputs[off + i]));
    st = perm(st).map(BigInt);
  }
  return st[1];
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a, m) => Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);

const circomlib = await buildPoseidon();
setPoseidonField(circomlib.F);
for (const c of ["transfer", "withdraw", "compliance"]) {
  for (const [v, hash] of [["base", circomlib], ["o2", circomlib], ["p2", p2hash], ["p2o2", p2hash]]) {
    const d = join(WORK, `${v}-${c}`);
    const wasm = join(d, `${c}_js`, `${c}.wasm`), zkey = join(d, `${c}_final.zkey`);
    const inputs = stringifyInputs(WITNESS_BUILDERS[c](hash));
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, wasm, zkey); // warm-up
    const vk = await snarkjs.zKey.exportVerificationKey(zkey);
    const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
    const t = [];
    for (let i = 0; i < RUNS; i++) { const a = process.hrtime.bigint(); await snarkjs.groth16.fullProve(inputs, wasm, zkey); t.push(Number(process.hrtime.bigint() - a) / 1e6); }
    const m = mean(t);
    console.log(`${c.padEnd(10)} ${v.padEnd(4)} verify=${ok} mean=${m.toFixed(1)}ms sd=${sd(t, m).toFixed(1)}ms min=${Math.min(...t).toFixed(1)}ms max=${Math.max(...t).toFixed(1)}ms`);
  }
}
process.exit(0);
