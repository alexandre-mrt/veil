#!/usr/bin/env node
// Node proving time, baseline vs Poseidon2 variants built by measure.sh.
//   node scripts/bench/poseidon2/prove-variants.mjs <WORK dir used by measure.sh> [RUNS]
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "../witnesses.mjs";
import { sponge } from "./poseidon2.mjs";
const W = process.argv[2] ?? "/tmp/p2measure"; const RUNS = parseInt(process.argv[3] ?? "10", 10);
const poseidon = await buildPoseidon(); setPoseidonField(poseidon.F);
const stats = (a) => { const m = a.reduce((x, y) => x + y) / a.length; return [m, Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length)]; };
for (const c of ["transfer", "withdraw", "compliance"]) {
  for (const variant of ["baseline", "poseidon2"]) {
    const D = join(W, variant, c);
    const hash = variant === "baseline" ? poseidon : (xs) => sponge(xs);
    const inputs = stringifyInputs(WITNESS_BUILDERS[c](hash));
    const wasm = join(D, `${c}_js`, `${c}.wasm`), zkey = join(D, `${c}.zkey`);
    await snarkjs.groth16.fullProve(inputs, wasm, zkey); // warm-up
    const t = [];
    for (let i = 0; i < RUNS; i++) { const a = process.hrtime.bigint(); await snarkjs.groth16.fullProve(inputs, wasm, zkey); t.push(Number(process.hrtime.bigint() - a) / 1e6); }
    const [m, sd] = stats(t);
    console.log(`${c.padEnd(10)} ${variant.padEnd(9)} mean ${m.toFixed(1)} ms  sd ${sd.toFixed(1)}  (n=${RUNS})`);
  }
}
process.exit(0);
