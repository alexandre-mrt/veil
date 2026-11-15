#!/usr/bin/env node
/**
 * compliance-binding.mjs — 2026-11-15 compliance-transfer-binding experiment.
 *
 * Part 1 (attack, real Groth16 proofs): Alice holds a KYC credential, Bob does not. Can
 * Alice produce a compliance proof that `compliant_transfer` will accept next to BOB's
 * transfer proof?
 *   - baseline circuit (contextId = H(6, transferNullifier, userSecret), never checked
 *     on-chain): yes — the proof verifies and nothing on-chain links it to Bob's transfer.
 *   - bound circuit (contextId = H(2, userSecret, epochId, rOld) = transfer nullifier, and
 *     compliance.move asserts contextId == transfer nullifier): Alice cannot build a witness.
 * Part 2: interleaved proving-time A/B (snarkjs groth16.fullProve) baseline vs bound.
 *
 * Usage (repo root, after building both artifact sets with scripts/bench/build-circuit.sh):
 *   git show main:circuits/compliance.circom > circuits/compliance.baseline.circom   # pre-change
 *   bash scripts/bench/build-circuit.sh compliance.baseline.circom circuits/build-compliance-baseline
 *   bash scripts/bench/build-circuit.sh compliance.circom circuits/build-compliance
 *   node scripts/bench/compliance-binding.mjs --runs 20
 */
import { buildPoseidon } from "circomlibjs";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { buildTransferWitness, buildComplianceWitness, setPoseidonField } from "./witnesses.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const C = join(__dirname, "..", "..", "circuits");
const RUNS = (() => { const i = process.argv.indexOf("--runs"); return i !== -1 ? +process.argv[i + 1] : 20; })();

function art(dir) {
  const files = readdirName(dir);
  return { wasm: join(dir, `${files}_js`, `${files}.wasm`), zkey: join(dir, `${files}_final.zkey`), vk: join(dir, `${files}_vk.json`) };
}
function readdirName(dir) {
  return existsSync(join(dir, "compliance.baseline_final.zkey")) ? "compliance.baseline" : "compliance";
}
const BASE = art(join(C, "build-compliance-baseline"));
const BOUND = art(join(C, "build-compliance"));

const poseidon = await buildPoseidon();
const F = poseidon.F;
const H = (xs) => F.toObject(poseidon(xs));
const str = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));

function credential(userSecret) {
  const leaf = H([4n, userSecret, 2n, 5000n, 1n]);
  const pathElements = [], pathIndices = [];
  let cur = leaf, z = 0n;
  for (let i = 0; i < 20; i++) { pathElements.push(z); pathIndices.push(0n); cur = H([cur, z]); z = H([z, z]); }
  return { merkleRoot: cur, pathElements, pathIndices };
}
const common = (secret) => ({ ...credential(secret), currentEpoch: 1000n, requiredKycLevel: 1n, validCredential: 1n,
  userSecret: secret, kycLevel: 2n, expiryEpoch: 5000n, issuerId: 1n });

const ALICE = 0xA11CEn, BOB = 0xB0Bn, EPOCH = 1000n, BOB_R = 424242n;
const bobTransferNullifier = H([2n, BOB, EPOCH, BOB_R]); // public on-chain (transfer_inputs[128..160])

// Baseline-shaped witness: Alice, contextId = H(6, bobNullifier, ALICE)
function baselineWitness(secret, tnf) {
  const contextId = H([6n, tnf, secret]);
  const { pathElements, pathIndices, ...rest } = common(secret);
  return { ...rest, pathElements, pathIndices, contextId, nullifier: H([5n, secret, contextId]), transferNullifier: tnf };
}
// Bound-shaped witness
function boundWitness(secret, epoch, rOld, contextIdOverride) {
  const contextId = contextIdOverride ?? H([2n, secret, epoch, rOld]);
  return { ...common(secret), contextId, nullifier: H([5n, secret, contextId]), transferEpochId: epoch, transferRandomnessOld: rOld };
}

async function prove(a, w) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(str(w), a.wasm, a.zkey);
  const ok = await snarkjs.groth16.verify(JSON.parse(readFileSync(a.vk, "utf8")), publicSignals, proof);
  return { ok, publicSignals };
}

console.log(`=== compliance-binding (node ${process.version}, ${process.platform}/${process.arch}) ===`);
console.log(`Bob's public transfer nullifier: ${bobTransferNullifier}\n`);

console.log("--- Part 0: cross-circuit — real transfer proof vs real bound compliance proof ---");
{
  setPoseidonField(F);
  const T = { wasm: join(C, "build", "transfer_js", "transfer.wasm"), zkey: join(C, "build", "transfer_final.zkey"), vk: join(C, "build", "transfer_vk.json") };
  const t = await prove(T, buildTransferWitness(poseidon));
  const c = await prove(BOUND, buildComplianceWitness(poseidon));
  console.log(`transfer proof verifies: ${t.ok}; compliance proof verifies: ${c.ok}`);
  console.log(`transfer publicSignals[4] (nullifier, bytes 128..160) == compliance publicSignals[2] (contextId, bytes 64..96): ${t.publicSignals[4] === c.publicSignals[2]}`);
}

console.log("\n--- Part 1: Alice's credential vouching for Bob's transfer ---");
{
  const r = await prove(BASE, baselineWitness(ALICE, bobTransferNullifier));
  const ctx = BigInt(r.publicSignals[2]);
  console.log(`[baseline] Alice proof verifies: ${r.ok}`);
  console.log(`[baseline] contextId == Bob's transfer nullifier: ${ctx === bobTransferNullifier} (main's compliance.move never compares them -> ACCEPTED on-chain)`);
}
{
  let threw = false, msg = "";
  try { await prove(BOUND, boundWitness(ALICE, EPOCH, BOB_R, bobTransferNullifier)); } catch (e) { threw = true; msg = String(e.message).split("\n")[0]; }
  console.log(`[bound]    Alice witness with contextId := Bob's nullifier rejected: ${threw} (${msg})`);
  const r = await prove(BOUND, boundWitness(ALICE, EPOCH, BOB_R));
  console.log(`[bound]    Alice's honest-shape proof verifies: ${r.ok}, contextId == Bob's nullifier: ${BigInt(r.publicSignals[2]) === bobTransferNullifier} -> compliance.move aborts 116`);
  const b = await prove(BOUND, boundWitness(BOB, EPOCH, BOB_R));
  console.log(`[bound]    (control) owner-bound proof verifies: ${b.ok}, contextId == transfer nullifier: ${BigInt(b.publicSignals[2]) === bobTransferNullifier}`);
}

console.log(`\n--- Part 2: proving time, interleaved, ${RUNS} runs each (+2 warm-up) ---`);
const wB = str(baselineWitness(BOB, bobTransferNullifier)), wN = str(boundWitness(BOB, EPOCH, BOB_R));
const tB = [], tN = [];
for (let i = 0; i < RUNS + 2; i++) {
  let t = performance.now(); await snarkjs.groth16.fullProve(wB, BASE.wasm, BASE.zkey); const dB = performance.now() - t;
  t = performance.now(); await snarkjs.groth16.fullProve(wN, BOUND.wasm, BOUND.zkey); const dN = performance.now() - t;
  if (i >= 2) { tB.push(dB); tN.push(dN); }
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2; };
for (const [n, a] of [["baseline", tB], ["bound", tN]]) console.log(`${n.padEnd(9)} mean ${mean(a).toFixed(1)} ms  sd ${sd(a).toFixed(1)}  median ${med(a).toFixed(1)}  min ${Math.min(...a).toFixed(1)}`);
const d = mean(tN) - mean(tB), se = Math.sqrt(sd(tB) ** 2 / RUNS + sd(tN) ** 2 / RUNS);
console.log(`delta     ${d >= 0 ? "+" : ""}${d.toFixed(1)} ms (${((d / mean(tB)) * 100).toFixed(1)}%), ${(d / se).toFixed(1)} SE`);
process.exit(0);
