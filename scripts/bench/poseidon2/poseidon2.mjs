/**
 * poseidon2.mjs — plain BigInt reference of the Poseidon2 BN254 t=3 permutation, line-for-line
 * with HorizenLabs/poseidon2 `Poseidon2::permutation` (external matrix circ(2,1,1), internal
 * matrix [[2,1,1],[1,2,1],[1,1,3]], x^5 S-box, 4+56+4 rounds, initial external linear layer).
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const __dirname = dirname(fileURLToPath(import.meta.url));
const C = JSON.parse(readFileSync(join(__dirname, "constants_bn254_t3.json"), "utf8"));
const RC = C.rc.map((r) => r.map(BigInt));

const mod = (x) => ((x % P) + P) % P;
const sbox = (x) => { const x2 = (x * x) % P; return (((x2 * x2) % P) * x) % P; };
const ext = (s) => { const sum = s[0] + s[1] + s[2]; return s.map((x) => mod(x + sum)); };
const int = (s) => { const sum = s[0] + s[1] + s[2]; return [mod(s[0] + sum), mod(s[1] + sum), mod(2n * s[2] + sum)]; };

export function permute(input) {
  let s = ext(input.map(mod));
  for (let r = 0; r < 4; r++) s = ext(s.map((x, i) => sbox(mod(x + RC[r][i]))));
  for (let r = 4; r < 60; r++) { s[0] = sbox(mod(s[0] + RC[r][0])); s = int(s); }
  for (let r = 60; r < 64; r++) s = ext(s.map((x, i) => sbox(mod(x + RC[r][i]))));
  return s;
}

/** 2-to-1 compression, same convention as the reference `MerkleTreeHash::compress`: perm([a,b,0])[0]. */
export const hash2 = (a, b) => permute([a, b, 0n])[0];
