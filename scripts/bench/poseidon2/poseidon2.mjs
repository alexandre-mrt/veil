// Plain-JS Poseidon2 (BN254, t=3) + the same rate-2 sponge as Poseidon2Sponge in the circom file.
// Constants are parsed from the generated poseidon2_bn254_t3.circom so there is one source of truth.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "poseidon2_bn254_t3.circom"), "utf8");
const RC = src.match(/var RC\[\d+\] = \[([^\]]+)\]/)[1].split(",").map((s) => BigInt(s.trim()));
const D = [1n, 1n, 2n];
const s5 = (x) => { const x2 = (x * x) % P; const x4 = (x2 * x2) % P; return (x4 * x) % P; };
const mExt = (s) => { const t = s[0] + s[1] + s[2]; return s.map((v) => (t + v) % P); };
const mInt = (s) => { const t = s[0] + s[1] + s[2]; return s.map((v, i) => (t + D[i] * v) % P); };
export function permute(inp) {
  let s = mExt(inp.map((x) => BigInt(x) % P));
  for (let r = 0; r < 64; r++) {
    if (r < 4 || r >= 60) { s = mExt(s.map((v, i) => s5((v + RC[r * 3 + i]) % P))); }
    else { s[0] = s5((s[0] + RC[r * 3]) % P); s = mInt(s); }
  }
  return s;
}
export function sponge(inputs) {
  const n = inputs.length, blocks = Math.ceil((n - 1) / 2); // matches (n-1+1)\2 in circom
  let st = [0n, 0n, BigInt(inputs[0])];
  for (let b = 0; b < blocks; b++) {
    const i0 = 1 + 2 * b, i1 = 2 + 2 * b;
    const a = (st[0] + (i0 < n ? BigInt(inputs[i0]) : 0n)) % P;
    const c = (st[1] + (i1 < n ? BigInt(inputs[i1]) : 0n)) % P;
    st = permute([a, c, st[2]]);
  }
  return st[0];
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(permute([0n, 1n, 2n]).join("\n"));
