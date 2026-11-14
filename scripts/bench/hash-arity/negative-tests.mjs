#!/usr/bin/env node
/**
 * negative-tests.mjs — soundness checks for the 4-ary Merkle template and the Poseidon2 circuit.
 *
 * Positive: every slot p ∈ {0,1,2,3} at every level is accepted; Poseidon2 circuit output equals
 * the KAT-checked JS reference; full transfer_quad / compliance_quad witnesses are accepted.
 * Negative (each must be REJECTED by witness generation, i.e. no satisfying assignment):
 *   Q1 wrong sibling                    Q2 non-boolean index bit (2)
 *   Q3 bits point at a different slot   Q4 index bits (p) consistent but node/sibling swapped
 *   Q5 field-wrapped bit (p - 1 ≡ -1)   Q6 leaf not in tree (transfer_quad, oldCommitment swapped)
 *   Q7 credential not in tree (compliance_quad)
 *   B1 Poseidon2 binary path, wrong sibling
 *   V1 a valid quad proof does not verify against a different public root
 *
 * Usage (after bench.mjs has built build/O1/*):
 *   node scripts/bench/hash-arity/negative-tests.mjs --ptau /path/pot14_final.ptau
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { WITNESS_BUILDERS, setPoseidonField } from "../witnesses.mjs";
import { hash2 as p2hash2, P as FIELD } from "./poseidon2.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const O1 = join(here, "build", "O1");
const wasm = (n) => join(O1, `${n}_js`, `${n}.wasm`);
for (const n of ["quad_poseidon_d10", "bin_poseidon2_d20", "transfer_quad", "compliance_quad"]) {
  if (!existsSync(wasm(n))) { console.error(`missing ${wasm(n)} — run bench.mjs first`); process.exit(1); }
}

const poseidon = await buildPoseidon();
const F = poseidon.F;
setPoseidonField(F);
const P = (xs) => F.toObject(poseidon(xs));
const S = (v) => Array.isArray(v) ? v.map(S) : v.toString();
const strIn = (w) => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, S(v)]));

let k = 1n;
const r = () => (k = (k * 6364136223846793005n + 1442695040888963407n) % FIELD);

function quad(leaf, positions) {
  const pathElements = [], pathIndices = [];
  let node = leaf;
  for (const p of positions) {
    const sibs = [r(), r(), r()];
    const kids = [...sibs]; kids.splice(p, 0, node);
    pathElements.push(sibs); pathIndices.push([BigInt(p & 1), BigInt(p >> 1)]);
    node = P(kids);
  }
  return { root: node, pathElements, pathIndices };
}

async function accepts(name, input) {
  try { await snarkjs.wtns.calculate(strIn(input), wasm(name), { type: "mem" }); return true; }
  catch { return false; }
}
let failures = 0;
function check(label, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (${want ? "accepted" : "rejected"} expected, ${got ? "accepted" : "rejected"} got)`);
}

// ── positive: every slot at every level ─────────────────────────────────────
for (let p = 0; p < 4; p++) {
  const leaf = r(); const t = quad(leaf, Array(10).fill(p));
  check(`P${p}  quad d10, node at slot ${p} on all 10 levels`, await accepts("quad_poseidon_d10", { root: t.root, leaf, pathElements: t.pathElements, pathIndices: t.pathIndices }), true);
}
{
  const pos = [0, 1, 2, 3, 3, 2, 1, 0, 2, 1];
  const leaf = r(); const t = quad(leaf, pos);
  check("P4  quad d10, mixed slots", await accepts("quad_poseidon_d10", { root: t.root, leaf, pathElements: t.pathElements, pathIndices: t.pathIndices }), true);

  // Q1 wrong sibling
  const pe = t.pathElements.map((x) => [...x]); pe[4][1] = pe[4][1] + 1n;
  check("Q1  wrong sibling at level 4", await accepts("quad_poseidon_d10", { root: t.root, leaf, pathElements: pe, pathIndices: t.pathIndices }), false);
  // Q2 non-boolean bit
  const pi2 = t.pathIndices.map((x) => [...x]); pi2[2] = [2n, 0n];
  check("Q2  index bit = 2 at level 2", await accepts("quad_poseidon_d10", { root: t.root, leaf, pathElements: t.pathElements, pathIndices: pi2 }), false);
  // Q3 bits claim a different slot than the one hashed
  for (let lvl of [0, 9]) for (let fake = 0; fake < 4; fake++) {
    if (fake === pos[lvl]) continue;
    const pi3 = t.pathIndices.map((x) => [...x]); pi3[lvl] = [BigInt(fake & 1), BigInt(fake >> 1)];
    check(`Q3  level ${lvl}: real slot ${pos[lvl]}, bits claim ${fake}`, await accepts("quad_poseidon_d10", { root: t.root, leaf, pathElements: t.pathElements, pathIndices: pi3 }), false);
  }
  // Q4 swap leaf with a sibling (prover tries to prove membership of a sibling value it knows)
  check("Q4  prove a sibling value as the leaf with the same path", await accepts("quad_poseidon_d10", { root: t.root, leaf: t.pathElements[0][0], pathElements: t.pathElements, pathIndices: t.pathIndices }), false);
  // Q5 field-wrapped bit: b = p-1 ≡ -1 (both b*(1-b) = -2 ≠ 0)
  const pi5 = t.pathIndices.map((x) => [...x]); pi5[3] = [FIELD - 1n, 0n];
  check("Q5  index bit = -1 mod p at level 3", await accepts("quad_poseidon_d10", { root: t.root, leaf, pathElements: t.pathElements, pathIndices: pi5 }), false);
  // V1 proof/root binding
  const zkey = join(O1, "quad_poseidon_d10.zkey");
  if (existsSync(zkey)) {
    const vk = await snarkjs.zKey.exportVerificationKey(zkey, { info() {}, debug() {}, warn() {}, error() {} });
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(strIn({ root: t.root, leaf, pathElements: t.pathElements, pathIndices: t.pathIndices }), wasm("quad_poseidon_d10"), zkey);
    check("V1a valid proof verifies against its own root", await snarkjs.groth16.verify(vk, publicSignals, proof), true);
    check("V1b same proof against root+1", await snarkjs.groth16.verify(vk, [(BigInt(publicSignals[0]) + 1n).toString()], proof), false);
  }
}

// ── Poseidon2 circuit vs reference ──────────────────────────────────────────
{
  const depth = 20, leaf = r(); const pe = [], pi = [];
  let node = leaf;
  for (let i = 0; i < depth; i++) { const s = r(), b = BigInt(i % 3 === 0 ? 1 : 0); pe.push(s); pi.push(b); node = b ? p2hash2(s, node) : p2hash2(node, s); }
  check("P5  Poseidon2 binary d20: circuit accepts root computed by KAT-checked JS reference", await accepts("bin_poseidon2_d20", { root: node, leaf, pathElements: pe, pathIndices: pi }), true);
  const pe2 = [...pe]; pe2[7] += 1n;
  check("B1  Poseidon2 binary d20: wrong sibling", await accepts("bin_poseidon2_d20", { root: node, leaf, pathElements: pe2, pathIndices: pi }), false);
}

// ── full-circuit variants ───────────────────────────────────────────────────
{
  const w = WITNESS_BUILDERS.transfer(poseidon);
  const t = quad(w.oldCommitment, [3, 0, 2, 1, 1, 2, 0, 3, 1, 2]);
  const good = { ...w, merkleRoot: t.root, pathElements: t.pathElements, pathIndices: t.pathIndices };
  check("P6  transfer_quad valid witness", await accepts("transfer_quad", good), true);
  // Q6: different (well-formed) oldCommitment not in the tree under this root
  const w2 = WITNESS_BUILDERS.transfer(poseidon);
  const other = { ...good, randomnessOld: 5n, oldCommitment: P([1n, w2.cumulativeOld, 5n, w2.userSecret]), nullifier: P([2n, w2.userSecret, w2.epochId, 5n]) };
  check("Q6  transfer_quad: well-formed commitment NOT in tree", await accepts("transfer_quad", other), false);
}
{
  const w = WITNESS_BUILDERS.compliance(poseidon);
  const leaf = P([4n, w.userSecret, w.kycLevel, w.expiryEpoch, w.issuerId]);
  const t = quad(leaf, [1, 1, 0, 3, 2, 2, 0, 1, 3, 0]);
  const good = { ...w, merkleRoot: t.root, pathElements: t.pathElements, pathIndices: t.pathIndices };
  check("P7  compliance_quad valid witness", await accepts("compliance_quad", good), true);
  check("Q7  compliance_quad: credential with forged kycLevel not in tree", await accepts("compliance_quad", { ...good, kycLevel: 3n }), false);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
