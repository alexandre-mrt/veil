/**
 * poseidon2.mjs — BigInt reference implementation of the BN254 t=3 Poseidon2 permutation
 * (HorizenLabs parameters, see gen-poseidon2-constants.mjs) plus the 2-to-1 compression used by
 * the bench Merkle circuits: H2(a, b) = Perm([0, a, b])[0] — same "capacity first, output lane 0"
 * convention as circomlib's Poseidon(2), so the two are drop-in comparable.
 *
 * Self-test: `node poseidon2.mjs` checks the HorizenLabs known-answer vector Perm([0,1,2]).
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const here = dirname(fileURLToPath(import.meta.url));
const C = JSON.parse(readFileSync(join(here, "poseidon2_bn254_t3.json"), "utf8"));
const RC = C.RC.map(r => r.map(BigInt));
const DIAG = C.diagM1.map(BigInt);

const mod = x => ((x % P) + P) % P;
const pow5 = x => { const x2 = x * x % P; return x2 * x2 % P * x % P; };
function ext(s) { const sum = mod(s[0] + s[1] + s[2]); return s.map(v => mod(v + sum)); }
function int(s) { const sum = mod(s[0] + s[1] + s[2]); return s.map((v, i) => mod(v * DIAG[i] + sum)); }

export function permute(input) {
  let s = ext(input.map(mod));
  const half = C.RF / 2;
  for (let r = 0; r < half; r++) s = ext(s.map((v, i) => pow5(mod(v + RC[r][i]))));
  for (let r = half; r < half + C.RP; r++) { s[0] = pow5(mod(s[0] + RC[r][0])); s = int(s); }
  for (let r = half + C.RP; r < C.RF + C.RP; r++) s = ext(s.map((v, i) => pow5(mod(v + RC[r][i]))));
  return s;
}
export const hash2 = (a, b) => permute([0n, BigInt(a), BigInt(b)])[0];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const kat = ["0x0bb61d24daca55eebcb1929a82650f328134334da98ea4f847f760054f4a3033",
               "0x303b6f7c86d043bfcbcc80214f26a30277a15d3f74ca654992defe7ff8d03570",
               "0x1ed25194542b12eef8617361c3ba7c52e660b145994427cc86296242cf766ec8"].map(BigInt);
  const out = permute([0n, 1n, 2n]);
  const ok = out.every((v, i) => v === kat[i]);
  console.log(`Poseidon2 BN254 t=3 KAT Perm([0,1,2]): ${ok ? "PASS" : "FAIL"}`);
  out.forEach((v, i) => console.log(`  out[${i}] = 0x${v.toString(16).padStart(64, "0")}`));
  process.exit(ok ? 0 : 1);
}
