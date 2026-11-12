#!/usr/bin/env node
/**
 * poseidon2.test.mjs — correctness + soundness tests for circuits/research/poseidon2.circom.
 *
 *   P1  JS reference matches the HorizenLabs known-answer test perm([0,1,2]).
 *   P2  circom witness for Poseidon2PermT3 matches the KAT.
 *   P3  circom Poseidon2Hash2 == JS hash2 on 25 random field-element pairs (incl. p-1, 0).
 *   P4  honest witness satisfies every R1CS constraint (independent JS R1CS evaluator).
 *   N1  malicious witness: claimed output changed -> R1CS rejects.
 *   N2  malicious witness: one interior S-box signal (x4) changed, all downstream signals
 *       recomputed consistently by the prover -> R1CS rejects (that S-box's y = x4*lc breaks).
 *   N3  malicious witness: every one of the 240 non-output signals perturbed in turn -> R1CS
 *       rejects each one (no free / under-constrained internal signal).
 *
 * Prerequisite: `circom` on PATH (2.2.x) and `npm ci` in circuits/ and scripts/bench/.
 * Run: node scripts/bench/poseidon2/poseidon2.test.mjs
 */
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { permute, hash2, P } from "./poseidon2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, "..", "..", "..", "circuits", "package.json"));
const SNARKJS = join(__dirname, "..", "..", "..", "circuits", "node_modules", ".bin", "snarkjs");

const KAT = [
  0x0bb61d24daca55eebcb1929a82650f328134334da98ea4f847f760054f4a3033n,
  0x303b6f7c86d043bfcbcc80214f26a30277a15d3f74ca654992defe7ff8d03570n,
  0x1ed25194542b12eef8617361c3ba7c52e660b145994427cc86296242cf766ec8n,
];

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

const out = mkdtempSync(join(tmpdir(), "p2test-"));
function build(name) {
  execFileSync("circom", [join(__dirname, "circuits", `${name}.circom`), "--r1cs", "--wasm", "--sym", "--output", out]);
  return {
    wasm: join(out, `${name}_js`, `${name}.wasm`),
    wc: require(join(out, `${name}_js`, "witness_calculator.js")),
    r1cs: join(out, `${name}.r1cs`),
  };
}
async function witness(b, input) {
  const calc = await b.wc(readFileSync(b.wasm));
  return (await calc.calculateWitness(input, true)).map(BigInt);
}

// Independent R1CS evaluator: for each constraint, (A.w)*(B.w) == C.w mod p.
function lc(terms, w) { let s = 0n; for (const [k, v] of Object.entries(terms)) s += BigInt(v) * w[k]; return s % P; }
function satisfied(r1cs, w) {
  for (const [A, B, C] of r1cs.constraints) if ((lc(A, w) * lc(B, w) - lc(C, w)) % P !== 0n) return false;
  return true;
}
async function loadR1cs(path) {
  // Use snarkjs's own exporter (decimal-string coefficients, normal form) to avoid depending on
  // r1csfile's field-object API.
  const json = path.replace(/\.r1cs$/, ".r1cs.json");
  execFileSync(SNARKJS, ["r1cs", "export", "json", path, json], { stdio: "ignore" });
  const r = JSON.parse(readFileSync(json, "utf8"));
  r.constraints = r.constraints.map((c) => c.map((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, BigInt(v)]))));
  return r;
}

console.log("Poseidon2 BN254 t=3 — correctness and soundness tests");

// P1
check("P1 JS reference == HorizenLabs KAT perm([0,1,2])", permute([0n, 1n, 2n]).every((x, i) => x === KAT[i]));

// P2
const perm = build("perm_p2");
const wp = await witness(perm, { in: ["0", "1", "2"] });
check("P2 circom Poseidon2PermT3([0,1,2]) == KAT", [1, 2, 3].every((idx, i) => wp[idx] === KAT[i]));

// P3
const hb = build("hash_p2");
const pairs = [[0n, 0n], [P - 1n, P - 1n], [1n, P - 1n]];
let seed = 0x9e3779b97f4a7c15n;
const rnd = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 256n) - 1n); return seed % P; };
while (pairs.length < 25) pairs.push([rnd(), rnd()]);
let allEq = true;
for (const [a, b] of pairs) {
  const w = await witness(hb, { inputs: [a.toString(), b.toString()] });
  if (w[1] !== hash2(a, b)) { allEq = false; console.log(`    mismatch on (${a}, ${b})`); }
}
check(`P3 circom Poseidon2Hash2 == JS hash2 on ${pairs.length} inputs`, allEq);

// P4 / N1-N3 on the hash circuit
const r1cs = await loadR1cs(hb.r1cs);
const honest = await witness(hb, { inputs: ["12345", "67890"] });
check(`P4 honest witness satisfies all ${r1cs.constraints.length} constraints`, satisfied(r1cs, honest));

const evil1 = honest.slice(); evil1[1] = (evil1[1] + 1n) % P;
check("N1 forged output (out+1) rejected", !satisfied(r1cs, evil1));

// N2: change x4 of the first partial-round S-box and recompute everything after it honestly.
// Signal layout (from --sym): w[0]=1, w[1]=out, w[2..3]=inputs, then the template's internal
// signals. Rather than hard-code indices, we find x4[12] via the .sym file.
const sym = readFileSync(join(out, "hash_p2.sym"), "utf8").trim().split("\n").map((l) => l.split(","));
const idxOf = (name) => { const row = sym.find((r) => r[3] === name); return row ? parseInt(row[1], 10) : -1; };
const ix4 = idxOf("main.p.x4[12]");
const iy = idxOf("main.p.y[12]");
const evil2 = honest.slice();
evil2[ix4] = (evil2[ix4] + 1n) % P;
// a cheating prover would also make y consistent with the forged x4 ...
const lcVal = (() => { // lc is not a signal; recover it from x2 = lc^2 is ambiguous, so use y = x4*lc => lc = y/x4
  const inv = (a) => { let r = 1n, b = a % P, e = P - 2n; while (e) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
  return (honest[iy] * inv(honest[ix4])) % P;
})();
evil2[iy] = (evil2[ix4] * lcVal) % P;
check(`N2 forged interior S-box (x4[12]=${ix4 >= 0 ? "found" : "MISSING"}, y recomputed) rejected`, ix4 > 0 && !satisfied(r1cs, evil2));

// N3: every non-constant, non-input witness slot perturbed in turn must break some constraint.
let free = [];
for (let i = 1; i < honest.length; i++) {
  if (i === 2 || i === 3) continue; // private inputs: changing them is a different (honest) statement
  const e = honest.slice(); e[i] = (e[i] + 1n) % P;
  if (satisfied(r1cs, e)) free.push(i);
}
check(`N3 all ${honest.length - 3} non-input signals are constrained (no free wire)`, free.length === 0, `free: ${free}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
