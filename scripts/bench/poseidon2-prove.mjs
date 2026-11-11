#!/usr/bin/env node
/**
 * poseidon2-prove.mjs — Groth16 proving time for transfer.circom under four builds:
 *   {circomlib Poseidon, Poseidon2} Merkle hasher  x  {default circom flags, --O2}
 *
 *   node scripts/bench/poseidon2-prove.mjs [--runs N] [--ptau path]
 *
 * Prereqs: `bash scripts/bench/poseidon2-r1cs.sh` and `OPT=--O2 bash scripts/bench/poseidon2-r1cs.sh`
 * (produce circuits/research/build{,-O2}/), and a pot15 ptau (default
 * circuits/research/ptau/pot15_final.ptau — any pot15 works; proving time doesn't depend on who
 * contributed). Each zkey gets a single dev contribution, exactly like circuits/scripts/compile*.sh.
 *
 * Also checks: every timed proof verifies against its own VK, and the NEGATIVE test — a witness
 * whose Merkle root was computed with the *other* hash is rejected by witness generation.
 */
import { buildPoseidon } from "circomlibjs";
import { existsSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { buildTransferWitness, setPoseidonField, stringifyInputs } from "./witnesses.mjs";
import { hash2 as p2hash2 } from "./poseidon2/poseidon2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const R = join(__dirname, "..", "..", "circuits", "research");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? process.argv[i + 1] : d; };
const RUNS = parseInt(arg("--runs", "10"), 10);
const SNARKJS = join(R, "..", "node_modules", ".bin", "snarkjs");
const PTAU = arg("--ptau", join(R, "ptau", "pot15_final.ptau"));

const VARIANTS = [
  { label: "transfer    (Poseidon,  default flags)", dir: "build", name: "transfer", hash: "p1" },
  { label: "transfer_p2 (Poseidon2, default flags)", dir: "build", name: "transfer_p2", hash: "p2" },
  { label: "transfer    (Poseidon,  --O2)", dir: "build-O2", name: "transfer", hash: "p1" },
  { label: "transfer_p2 (Poseidon2, --O2)", dir: "build-O2", name: "transfer_p2", hash: "p2" },
];

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a, m) => Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
const silent = { info() {}, warn() {}, error() {}, debug() {} };

function rootWith(hash, leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < pathElements.length; i++) {
    const [l, r] = pathIndices[i] === 0n ? [node, pathElements[i]] : [pathElements[i], node];
    node = hash(l, r);
  }
  return node;
}

async function main() {
  const poseidon = await buildPoseidon();
  setPoseidonField(poseidon.F);
  const p1hash2 = (a, b) => poseidon.F.toObject(poseidon([a, b]));
  const base = buildTransferWitness(poseidon);
  const witnessFor = (h) => stringifyInputs({
    ...base,
    merkleRoot: rootWith(h === "p1" ? p1hash2 : p2hash2, base.oldCommitment, base.pathElements, base.pathIndices),
  });

  console.log(`=== transfer.circom proving time: Poseidon vs Poseidon2 Merkle, default vs --O2 (${RUNS} runs) ===`);
  console.log(`node ${process.version}, ${process.platform}/${process.arch}, ptau ${PTAU}\n`);
  const results = [];

  for (const v of VARIANTS) {
    const d = join(R, v.dir);
    const wasm = join(d, `${v.name}_js`, `${v.name}.wasm`);
    const r1cs = join(d, `${v.name}.r1cs`);
    const z0 = join(d, `${v.name}_0000.zkey`), zkey = join(d, `${v.name}_final.zkey`);
    if (!existsSync(zkey)) {
      // CLI, same sequence as circuits/scripts/compile*.sh (the in-process zKey.newZKey call
      // stalled for >10 min on this machine where the CLI takes ~8 s).
      execFileSync(SNARKJS, ["groth16", "setup", r1cs, PTAU, z0], { stdio: "ignore" });
      execFileSync(SNARKJS, ["zkey", "contribute", z0, zkey, "--name=veil-research-dev", `-e=nightly-${Date.now()}`], { stdio: "ignore" });
    }
    const vk = await snarkjs.zKey.exportVerificationKey(zkey);
    const info = await snarkjs.r1cs.info(r1cs, silent);

    const inputs = witnessFor(v.hash);
    const warm = await snarkjs.groth16.fullProve(inputs, wasm, zkey);
    const verified = await snarkjs.groth16.verify(vk, warm.publicSignals, warm.proof, silent);

    // NEGATIVE: root computed with the other hash must not produce a witness.
    let crossRejected = false;
    try { await snarkjs.wtns.calculate(witnessFor(v.hash === "p1" ? "p2" : "p1"), wasm, { type: "mem" }); }
    catch { crossRejected = true; }

    const times = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      await snarkjs.groth16.fullProve(inputs, wasm, zkey);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const m = mean(times);
    const row = {
      variant: v.label, constraints: info.nConstraints, wires: info.nVars,
      zkeyBytes: statSync(zkey).size, vkBytes: Buffer.byteLength(JSON.stringify(vk)),
      meanMs: +m.toFixed(1), stddevMs: +sd(times, m).toFixed(1),
      minMs: +Math.min(...times).toFixed(1), maxMs: +Math.max(...times).toFixed(1),
      proofVerifies: verified, crossHashWitnessRejected: crossRejected,
    };
    results.push(row);
    console.log(`--- ${v.label} ---`);
    console.log(`  constraints ${row.constraints}, wires ${row.wires}, zkey ${row.zkeyBytes} B, vk ${row.vkBytes} B`);
    console.log(`  mean ${row.meanMs} ms  sd ${row.stddevMs}  min ${row.minMs}  max ${row.maxMs}`);
    console.log(`  proof verifies: ${verified}   NEGATIVE cross-hash root rejected: ${crossRejected}\n`);
  }
  console.log("=== Summary (JSON) ===");
  console.log(JSON.stringify(results, null, 2));
  const ok = results.every((r) => r.proofVerifies && r.crossHashWitnessRejected);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Benchmark failed:", e); process.exit(1); });
