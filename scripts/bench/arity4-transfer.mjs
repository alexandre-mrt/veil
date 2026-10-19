#!/usr/bin/env node
/**
 * arity4-transfer.mjs — end-to-end experiment: transfer.circom with a 4-ary Poseidon(4) Merkle tree of
 * depth 10 (same 2^20 capacity) instead of the binary depth-20 tree. Reports constraints, zkey size,
 * Node proving time (baseline transfer vs variant, same machine, same local ptau), verifies proofs, and
 * runs negative tests (malicious witnesses must be rejected).
 *
 * Usage: node scripts/bench/arity4-transfer.mjs --circom <circom binary> [--runs N] [--work DIR]
 * Needs: cd circuits && npm ci   (circomlib, circomlibjs, snarkjs)
 * The ptau is generated locally (dev-only, timing is independent of ptau provenance) — nothing is downloaded.
 */
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, cpSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { buildTransferWitness, setPoseidonField, stringifyInputs } from "./witnesses.mjs";

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const circom = arg("--circom", "circom");
const RUNS = +arg("--runs", 10);
const work = resolve(arg("--work", join(tmpdir(), "veil-arity4")));
const libs = join(root, "circuits/node_modules");
const snarkjsBin = join(libs, ".bin/snarkjs");
mkdirSync(work, { recursive: true });
const sh = (bin, a, o = {}) => execFileSync(bin, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...o });

// ── 1. generate variant circuit from the real transfer.circom ─────────────────────────────
const MERKLE4 = `
template MerkleProof4(depth) {
  signal input leaf; signal input slots[depth][4]; signal input bits[depth][2]; signal output root;
  signal nodes[depth+1]; nodes[0] <== leaf;
  component h[depth];
  signal b01[depth]; signal ind[depth][4]; signal sel[depth][4];
  for (var i = 0; i < depth; i++) {
    bits[i][0]*(1-bits[i][0]) === 0; bits[i][1]*(1-bits[i][1]) === 0;
    b01[i] <== bits[i][0]*bits[i][1];
    ind[i][0] <== 1 - bits[i][0] - bits[i][1] + b01[i];
    ind[i][1] <== bits[i][0] - b01[i];
    ind[i][2] <== bits[i][1] - b01[i];
    ind[i][3] <== b01[i];
    var acc = 0;
    for (var j = 0; j < 4; j++) { sel[i][j] <== ind[i][j]*slots[i][j]; acc += sel[i][j]; }
    acc === nodes[i];
    h[i] = Poseidon(4);
    for (var j = 0; j < 4; j++) h[i].inputs[j] <== slots[i][j];
    nodes[i+1] <== h[i].out;
  }
  root <== nodes[depth];
}
`;
let src = readFileSync(join(root, "circuits/transfer.circom"), "utf8");
const sub = (from, to) => { if (!src.includes(from)) throw new Error("pattern missing: " + from); src = src.replace(from, to); };
sub('include "templates/merkle_proof.circom";', MERKLE4);
sub("signal input pathElements[20];", "signal input slots[10][4];");
sub("signal input pathIndices[20];", "signal input bits[10][2];");
sub("MerkleProof(20)", "MerkleProof4(10)");
sub("for (var i = 0; i < 20; i++) {\n        membershipProof", "for (var i = 0; i < 10; i++) {\n        membershipProof");
sub("membershipProof.pathElements[i] <== pathElements[i];", "for (var j = 0; j < 4; j++) { membershipProof.slots[i][j] <== slots[i][j]; }");
sub("membershipProof.pathIndices[i] <== pathIndices[i];", "membershipProof.bits[i][0] <== bits[i][0]; membershipProof.bits[i][1] <== bits[i][1];");
writeFileSync(join(work, "transfer_arity4.circom"), src);

// baseline: same file as the repo's, includes rewritten the same way (copy templates alongside)
let base = readFileSync(join(root, "circuits/transfer.circom"), "utf8");
mkdirSync(join(work, "templates"), { recursive: true });
if (!existsSync(join(work, "node_modules/circomlib"))) cpSync(join(libs, "circomlib"), join(work, "node_modules/circomlib"), { recursive: true }); // circom2 (WASI) cannot follow symlinks out of cwd
writeFileSync(join(work, "templates/merkle_proof.circom"), readFileSync(join(root, "circuits/templates/merkle_proof.circom"), "utf8"));
writeFileSync(join(work, "transfer_base.circom"), base);

// ── 2. compile + local ptau + groth16 setup ──────────────────────────────────────────────
const ptau = join(work, "pot15_final.ptau");
if (!existsSync(ptau)) {
  sh(snarkjsBin, ["powersoftau", "new", "bn128", "15", join(work, "p0.ptau")]);
  sh(snarkjsBin, ["powersoftau", "contribute", join(work, "p0.ptau"), join(work, "p1.ptau"), "--name=bench", "-e=bench-entropy"]);
  sh(snarkjsBin, ["powersoftau", "prepare", "phase2", join(work, "p1.ptau"), ptau]);
}
const variants = {};
for (const name of ["base", "arity4"]) {
  const c = join(work, `transfer_${name}.circom`);
  const log = sh(circom, [c, "--r1cs", "--wasm", "-o", work], { cwd: work });
  const nl = /non-linear constraints: (\d+)/.exec(log)[1], lin = /linear constraints: (\d+)/.exec(log)[1];
  const r1cs = join(work, `transfer_${name}.r1cs`);
  const zkey0 = join(work, `${name}_0.zkey`), zkey = join(work, `${name}.zkey`), vkp = join(work, `${name}_vk.json`);
  if (!existsSync(zkey) || process.argv.includes("--fresh")) { // setup is minutes-slow; cache across runs
    sh(snarkjsBin, ["groth16", "setup", r1cs, ptau, zkey0]);
    sh(snarkjsBin, ["zkey", "contribute", zkey0, zkey, "--name=bench", "-e=bench2"]);
  }
  sh(snarkjsBin, ["zkey", "export", "verificationkey", zkey, vkp]);
  const total = +/# of Constraints: (\d+)/.exec(sh(snarkjsBin, ["r1cs", "info", r1cs]))[1];
  variants[name] = {
    total, nonLinear: +nl, linear: total - +nl, zkeyBytes: statSync(zkey).size,
    wasm: join(work, `transfer_${name}_js/transfer_${name}.wasm`), zkey, vk: JSON.parse(readFileSync(vkp, "utf8")),
  };
}

// ── 3. witnesses ─────────────────────────────────────────────────────────────────────────
const poseidon = await buildPoseidon();
setPoseidonField(poseidon.F);
const H = (xs) => poseidon.F.toObject(poseidon(xs));
function arity4Witness(positions, mutate = {}) {
  const w = buildTransferWitness(poseidon);
  const slots = [], bits = [];
  let node = w.oldCommitment;
  for (let i = 0; i < 10; i++) {
    const p = positions[i];
    const s = [1000n + BigInt(i), 2000n + BigInt(i), 3000n + BigInt(i), 4000n + BigInt(i)];
    s[p] = node;
    slots.push(s); bits.push([BigInt(p & 1), BigInt(p >> 1)]);
    node = H(s);
  }
  delete w.pathElements; delete w.pathIndices;
  return { ...w, merkleRoot: node, slots, bits, ...mutate };
}
const flat = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

// ── 4. proving time ──────────────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const inputs = {
  base: stringifyInputs(buildTransferWitness(poseidon)),
  arity4: flat(arity4Witness([0, 1, 2, 3, 0, 1, 2, 3, 3, 2])),
};
const out = { runs: RUNS, node: process.version, variants: {} };
// Interleaved (base, arity4, base, ...) so drift / thermal / noisy-neighbour effects hit both equally.
const times = { base: [], arity4: [] }, ok = {};
for (const name of ["base", "arity4"]) {
  const v = variants[name];
  const warm = await snarkjs.groth16.fullProve(inputs[name], v.wasm, v.zkey); // warm-up, not counted
  ok[name] = await snarkjs.groth16.verify(v.vk, warm.publicSignals, warm.proof);
}
for (let i = 0; i < RUNS; i++) {
  for (const name of ["base", "arity4"]) {
    const t0 = process.hrtime.bigint();
    await snarkjs.groth16.fullProve(inputs[name], variants[name].wasm, variants[name].zkey);
    times[name].push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
}
for (const name of ["base", "arity4"]) {
  const v = variants[name], t = times[name];
  out.variants[name] = { constraints: v.total, nonLinear: v.nonLinear, linear: v.linear, zkeyBytes: v.zkeyBytes, verifies: ok[name], meanMs: +mean(t).toFixed(1), sdMs: +sd(t).toFixed(1), minMs: +Math.min(...t).toFixed(1) };
}

// ── 5. negative tests on the arity-4 circuit: each malicious witness must be REJECTED ──────
const rejects = async (label, inp) => {
  try { await snarkjs.groth16.fullProve(flat(inp), variants.arity4.wasm, variants.arity4.zkey); return { label, rejected: false }; }
  catch (e) { return { label, rejected: true, why: String(e.message).split("\n")[0].slice(0, 90) }; }
};
const good = arity4Witness([0, 1, 2, 3, 0, 1, 2, 3, 3, 2]);
const neg = [];
neg.push(await rejects("N1 wrong position bit at level 3 (node not at claimed slot)", { ...good, bits: good.bits.map((b, i) => (i === 3 ? [b[0] ^ 1n, b[1]] : b)) }));
neg.push(await rejects("N2 non-boolean position bit (2)", { ...good, bits: good.bits.map((b, i) => (i === 0 ? [2n, b[1]] : b)) }));
neg.push(await rejects("N3 sibling tampered, root unchanged", { ...good, slots: good.slots.map((s, i) => (i === 5 ? s.map((x, j) => (j === 0 ? x + 1n : x)) : s)) }));
neg.push(await rejects("N4 leaf not in tree (oldCommitment replaced)", { ...good, oldCommitment: good.oldCommitment + 1n }));
neg.push(await rejects("N5 node moved from slot 3 to slot 2 at level 7, bits still (1,1)", { ...good, slots: good.slots.map((s, i) => (i === 7 ? [s[0], s[1], s[3], s[2]] : s)) }));
out.negative = neg;
console.log(JSON.stringify(out, null, 2));
process.exit(0); // snarkjs leaves worker handles open (see EXPERIMENTS #12)
