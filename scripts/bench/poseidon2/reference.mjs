/** Poseidon2/BN254 BigInt reference (t=3, t=4), mirrors HorizenLabs poseidon2.rs `permutation`. */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const K = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../circuits/experiments/poseidon2/constants.json"), "utf8"));
const m = (x) => ((x % P) + P) % P;
const pow5 = (x) => { const x2 = m(x * x); return m(m(x2 * x2) * x); };
function ext(t, x) {
  if (t === 3) { const s = m(x[0] + x[1] + x[2]); return x.map((v) => m(v + s)); }
  const t0 = x[0] + x[1], t1 = x[2] + x[3], t2 = 2n * x[1] + t1, t3 = 2n * x[3] + t0, t4 = 4n * t1 + t3, t5 = 4n * t0 + t2;
  return [m(t3 + t5), m(t5), m(t2 + t4), m(t4)];
}
function int(t, x) {
  const d = (t === 3 ? K.diag3 : K.diag4).map(BigInt);
  const s = x.reduce((a, b) => a + b, 0n);
  return x.map((v, i) => m(d[i] * v + s));
}
export function permute(t, input) {
  const rc = (t === 3 ? K.rc3 : K.rc4).map((r) => r.map(BigInt));
  let st = ext(t, input.map(m));
  for (let r = 0; r < 64; r++) {
    const full = r < 4 || r >= 60;
    st = st.map((v, i) => (full || i === 0 ? pow5(v + rc[r][i]) : v));
    st = full ? ext(t, st) : int(t, st);
  }
  return st;
}
export const hash2 = (cap, a, b) => permute(3, [a, b, cap])[0];
export const hash3 = (cap, a, b, c) => permute(4, [a, b, c, cap])[0];
