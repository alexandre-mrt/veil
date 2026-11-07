// Poseidon2 (BN254 scalar field, t=3, x^5, R_F=8, R_P=56) — JS reference, matches HorizenLabs plain impl.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const C = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "constants-bn254-t3.json"), "utf8"));
export const RC = C.rc.map((r) => r.map(BigInt));
export const KAT = C;
const m = (x) => ((x % P) + P) % P;
const s5 = (x) => { const x2 = m(x * x), x4 = m(x2 * x2); return m(x4 * x); };
const ext = (s) => { const sum = m(s[0] + s[1] + s[2]); return s.map((v) => m(v + sum)); };
const int = (s) => { const sum = m(s[0] + s[1] + s[2]); return [m(s[0] + sum), m(s[1] + sum), m(2n * s[2] + sum)]; };
export function permute(input) {
  let s = ext(input.map(BigInt));
  for (let r = 0; r < 4; r++) s = ext(s.map((v, i) => s5(v + RC[r][i])));
  for (let r = 4; r < 60; r++) { s[0] = s5(s[0] + RC[r][0]); s = int(s); }
  for (let r = 60; r < 64; r++) s = ext(s.map((v, i) => s5(v + RC[r][i])));
  return s;
}
export const compress = (a, b) => permute([a, b, 0n])[0];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = permute([0n, 1n, 2n]);
  const want = KAT.kat_output_hex.map(BigInt);
  const ok = out.every((v, i) => v === want[i]);
  console.log("perm([0,1,2]) =", out.map((v) => "0x" + v.toString(16).padStart(64, "0")));
  console.log(ok ? "KAT: PASS (matches HorizenLabs reference vector)" : "KAT: FAIL");
  process.exit(ok ? 0 : 1);
}
