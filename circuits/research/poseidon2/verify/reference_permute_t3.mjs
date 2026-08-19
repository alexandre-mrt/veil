// Independent, from-scratch Poseidon2(t=3) permutation over the BN254 scalar field, written
// directly against the primary reference source — HorizenLabs/poseidon2 @ 055bde3f
// (https://github.com/HorizenLabs/poseidon2), the paper authors' repo, cloned read-only and not
// vendored into this repo — NOT reusing any code from @taceo/circom-lib (which
// circuits/research/poseidon2/vendor/ vendors) or @zkpassport/poseidon2. The external/internal
// matrix formulas below are transcribed from that repo's poseidon2.rs `matmul_external`/
// `matmul_internal` (t=3 branch); the round constants in rc3_hex.json are extracted verbatim
// from poseidon2_instance_bn256.rs's `RC3` table (bn256 = BN254's scalar field). Used only to
// cross-check the vendored circom circuit's witness output — see verify.mjs and
// docs/research/2026-08-19-poseidon2-arity-benchmark.md.
import { readFileSync } from "node:fs";

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function mod(x) {
  const r = x % P;
  return r < 0n ? r + P : r;
}

const RC3_HEX = JSON.parse(readFileSync(new URL("./rc3_hex.json", import.meta.url)));
const RC3 = [];
for (let i = 0; i < RC3_HEX.length; i += 3) {
  RC3.push([BigInt(RC3_HEX[i]), BigInt(RC3_HEX[i + 1]), BigInt(RC3_HEX[i + 2])]);
}
if (RC3.length !== 64) throw new Error(`expected 64 RC3 rows, got ${RC3.length}`);

const ROUNDS_F_BEGINNING = 4;
const ROUNDS_P = 56;
const ROUNDS_F_END = 4;

function sbox5(x) {
  const x2 = mod(x * x);
  const x4 = mod(x2 * x2);
  return mod(x4 * x);
}

// external matrix circ(2,1,1): sum = s0+s1+s2; out_i = s_i + sum
function matmulExternal3(s) {
  const sum = mod(s[0] + s[1] + s[2]);
  return [mod(s[0] + sum), mod(s[1] + sum), mod(s[2] + sum)];
}

// internal matrix [[2,1,1],[1,2,1],[1,1,3]]: sum = s0+s1+s2; out0=s0+sum; out1=s1+sum; out2=2*s2+sum
function matmulInternal3(s) {
  const sum = mod(s[0] + s[1] + s[2]);
  return [mod(s[0] + sum), mod(s[1] + sum), mod(2n * s[2] + sum)];
}

export function permuteT3(input) {
  if (input.length !== 3) throw new Error("expected 3 field elements");
  let state = matmulExternal3(input.map(mod));

  let r = 0;
  for (let i = 0; i < ROUNDS_F_BEGINNING; i++, r++) {
    state = state.map((v, j) => mod(v + RC3[r][j]));
    state = state.map(sbox5);
    state = matmulExternal3(state);
  }
  for (let i = 0; i < ROUNDS_P; i++, r++) {
    state[0] = mod(state[0] + RC3[r][0]);
    state[0] = sbox5(state[0]);
    state = matmulInternal3(state);
  }
  for (let i = 0; i < ROUNDS_F_END; i++, r++) {
    state = state.map((v, j) => mod(v + RC3[r][j]));
    state = state.map(sbox5);
    state = matmulExternal3(state);
  }
  if (r !== 64) throw new Error(`consumed ${r} RC rows, expected 64`);
  return state;
}
