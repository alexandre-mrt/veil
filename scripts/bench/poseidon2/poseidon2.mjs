/**
 * poseidon2.mjs — BigInt reference implementation of the Poseidon2 permutation over BN254, t=3,
 * d=5, RF=8, RP=56 (HorizenLabs reference parameters, eprint 2023/323).
 *
 * Research-only. Exists so the nightly loop can (a) check the circom template in
 * circuits/research/poseidon2.circom against the published known-answer test and (b) build
 * matching witnesses for the Poseidon2-Merkle variant of transfer.circom. Not used by the protocol.
 *
 *   node scripts/bench/poseidon2/poseidon2.mjs     # runs the KAT self-check
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const C = JSON.parse(readFileSync(join(__dirname, "bn254_t3_constants.json"), "utf8"));
const RC = C.rc.map((row) => row.map(BigInt));
const RF_HALF = C.RF / 2;

const mod = (x) => ((x % P) + P) % P;
const pow5 = (x) => { const x2 = (x * x) % P; return (((x2 * x2) % P) * x) % P; };

// circ(2,1,1): y_i = x_i + sum(x)
function external(s) { const sum = s[0] + s[1] + s[2]; return s.map((x) => mod(x + sum)); }
// [[2,1,1],[1,2,1],[1,1,3]]: y_i = d_i * x_i + sum(x), d = [1,1,2]
function internal(s) { const sum = s[0] + s[1] + s[2]; return [mod(s[0] + sum), mod(s[1] + sum), mod(2n * s[2] + sum)]; }

export function permute(input) {
  let s = external(input.map((x) => mod(BigInt(x))));
  for (let r = 0; r < RF_HALF; r++) s = external(s.map((x, i) => pow5(mod(x + RC[r][i]))));
  for (let r = RF_HALF; r < RF_HALF + C.RP; r++) { s[0] = pow5(mod(s[0] + RC[r][0])); s = internal(s); }
  for (let r = RF_HALF + C.RP; r < C.RF + C.RP; r++) s = external(s.map((x, i) => pow5(mod(x + RC[r][i]))));
  return s;
}

/** 2-to-1 hash with the same sponge layout circomlib's Poseidon(2) uses: state [0, a, b] → out[0]. */
export const hash2 = (a, b) => permute([0n, BigInt(a), BigInt(b)])[0];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = permute([0n, 1n, 2n]).map((x) => "0x" + x.toString(16).padStart(64, "0"));
  const kat = [
    "0x0bb61d24daca55eebcb1929a82650f328134334da98ea4f847f760054f4a3033",
    "0x303b6f7c86d043bfcbcc80214f26a30277a15d3f74ca654992defe7ff8d03570",
    "0x1ed25194542b12eef8617361c3ba7c52e660b145994427cc86296242cf766ec8",
  ];
  console.log("permute([0,1,2]) =", out);
  const ok = out.every((x, i) => x === kat[i]);
  console.log(ok ? "KAT PASS (matches HorizenLabs poseidon2_tests_bn256)" : "KAT FAIL");
  process.exit(ok ? 0 : 1);
}
