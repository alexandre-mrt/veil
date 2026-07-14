// snarkjs benchmark on the freshly compiled current transfer.circom.
// Same machine, same canonical witness (js/input.json from gen_input.mjs).
// Run: node js/bench_snarkjs.mjs   (from experiments/arkworks/)
import * as snarkjs from "../../../circuits/node_modules/snarkjs/main.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const r1cs = path.join(root, "build-circom", "transfer.r1cs");
const wasm = path.join(root, "build-circom", "transfer_js", "transfer.wasm");
const ptau = path.join(root, "..", "..", "circuits", "build", "pot15_final.ptau");
const zkey = path.join(root, "build-circom", "transfer_fresh.zkey");
const input = JSON.parse(readFileSync(path.join(here, "input.json"), "utf8"));

const info = await snarkjs.r1cs.info(r1cs);
console.log("constraints:", info.nConstraints, "| pub inputs:", info.nPubInputs, "| prv inputs:", info.nPrvInputs);

let t0 = performance.now();
await snarkjs.zKey.newZKey(r1cs, ptau, zkey);
console.log(`setup (zkey new): ${(performance.now() - t0).toFixed(1)} ms`);

// witness generation
t0 = performance.now();
const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
console.log(`fullProve (witness + prove), first call: ${(performance.now() - t0).toFixed(1)} ms`);

// prove-only average (witness recomputed each time by fullProve; also time wtns separately)
t0 = performance.now();
const wtns = { type: "mem" };
await snarkjs.wtns.calculate(input, wasm, wtns);
console.log(`witness calc: ${(performance.now() - t0).toFixed(1)} ms`);

const PROVE_ITERS = 5;
t0 = performance.now();
let p;
for (let i = 0; i < PROVE_ITERS; i++) {
  p = await snarkjs.groth16.prove(zkey, wtns);
}
console.log(`prove only (avg of ${PROVE_ITERS}): ${((performance.now() - t0) / PROVE_ITERS).toFixed(1)} ms`);

const vkey = await snarkjs.zKey.exportVerificationKey(zkey);
const VERIFY_ITERS = 20;
t0 = performance.now();
let ok;
for (let i = 0; i < VERIFY_ITERS; i++) {
  ok = await snarkjs.groth16.verify(vkey, p.publicSignals, p.proof);
}
console.log(`verify (avg of ${VERIFY_ITERS}): ${((performance.now() - t0) / VERIFY_ITERS).toFixed(1)} ms | ok: ${ok}`);
console.log("publicSignals:", p.publicSignals);
process.exit(0);
