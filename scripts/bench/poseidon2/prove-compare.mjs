#!/usr/bin/env node
/**
 * prove-compare.mjs — Groth16 setup + proving-time A/B: shipped transfer.circom vs transfer_p2_all.
 * Same machine, same process, interleaved runs (A,B,A,B,...) to cancel thermal / load drift.
 *   node scripts/bench/poseidon2/prove-compare.mjs <outdir from constraints.sh> <pot15.ptau> [--runs N] [--opt O1|O2]
 * Dev-only single-contribution zkeys (same as circuits/scripts/compile.sh) — NOT a ceremony.
 */
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { join } from "path";
import { existsSync, statSync } from "fs";
import { randomBytes } from "crypto";
import { P, hash2, hash3 } from "./reference.mjs";
import { WITNESS_BUILDERS, setPoseidonField, stringifyInputs } from "../witnesses.mjs";

const args = process.argv.slice(2);
const OUT = args[0], PTAU = args[1];
const RUNS = +(args[args.indexOf("--runs") + 1] || 15);
const OPT = args.includes("--opt") ? args[args.indexOf("--opt") + 1] : "O1";
const dir = (n) => join(OUT, OPT, n);
const wasm = (n) => join(dir(n), `${n}_js`, `${n}.wasm`);
const zkey = (n) => join(dir(n), `${n}_final.zkey`);

for (const n of ["transfer", "transfer_p2_all"]) {
  if (!existsSync(zkey(n))) {
    const t0 = performance.now();
    await snarkjs.zKey.newZKey(join(dir(n), `${n}.r1cs`), PTAU, join(dir(n), `${n}_0.zkey`));
    await snarkjs.zKey.contribute(join(dir(n), `${n}_0.zkey`), zkey(n), "dev", randomBytes(32).toString("hex"));
    console.log(`setup ${n}: ${((performance.now() - t0) / 1000).toFixed(1)} s, zkey ${statSync(zkey(n)).size} bytes`);
  } else console.log(`zkey ${n}: ${statSync(zkey(n)).size} bytes (existing)`);
}
const vk = {};
for (const n of ["transfer", "transfer_p2_all"]) vk[n] = await snarkjs.zKey.exportVerificationKey(zkey(n));

// inputs: baseline uses the shared bench witness; p2 variant uses the Poseidon2 reference.
const poseidon = await buildPoseidon(); setPoseidonField(poseidon.F);
const inA = stringifyInputs(WITNESS_BUILDERS.transfer(poseidon));
const rnd = () => BigInt("0x" + randomBytes(32).toString("hex")) % P;
const [us, rO, rN, salt] = [rnd(), rnd(), rnd(), rnd()];
const cumOld = 0n, tx = 100n, cumNew = 100n, epochId = 1n;
const oldC = hash3(1n, cumOld, rO, us);
let node = oldC; const pe = Array.from({ length: 20 }, () => 0n), pi = Array.from({ length: 20 }, () => 0n);
for (let i = 0; i < 20; i++) node = hash2(0n, node, pe[i]);
const inB = stringifyInputs({ oldCommitment: oldC, newCommitment: hash3(1n, cumNew, rN, us), threshold: 1000000000n, epochId,
  nullifier: hash3(2n, us, epochId, rO), txAmountHash: hash2(3n, tx, salt), merkleRoot: node, cumulativeOld: cumOld, cumulativeNew: cumNew,
  txAmount: tx, randomnessOld: rO, randomnessNew: rN, userSecret: us, salt, pathElements: pe, pathIndices: pi });

const cases = { transfer: inA, transfer_p2_all: inB };
const times = { transfer: [], transfer_p2_all: [] }, wit = { transfer: [], transfer_p2_all: [] };
for (const n of Object.keys(cases)) { // warm-up + verify
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(cases[n], wasm(n), zkey(n));
  console.log(`verify ${n}:`, await snarkjs.groth16.verify(vk[n], publicSignals, proof));
}
for (let i = 0; i < RUNS; i++) for (const n of Object.keys(cases)) {
  const t0 = process.hrtime.bigint();
  await snarkjs.groth16.fullProve(cases[n], wasm(n), zkey(n));
  times[n].push(Number(process.hrtime.bigint() - t0) / 1e6);
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / a.length);
console.log(`\n=== fullProve (witness + prove), ${RUNS} interleaved runs, --${OPT}, node ${process.version} ===`);
for (const n of Object.keys(cases)) console.log(`${n.padEnd(18)} mean ${mean(times[n]).toFixed(1)} ms  sd ${sd(times[n]).toFixed(1)}  min ${Math.min(...times[n]).toFixed(1)}  zkey ${statSync(zkey(n)).size} B`);
console.log(`ratio p2_all/baseline (mean): ${(mean(times.transfer_p2_all) / mean(times.transfer)).toFixed(3)}`);
process.exit(0);
