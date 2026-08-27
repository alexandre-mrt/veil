/**
 * poseidon2-sponge.mjs — JS-side Poseidon2Sponge, matching
 * @taceo/circom-lib's Poseidon2SpongeWithDs(N, T) bit-for-bit for the
 * single-block case used throughout this benchmark (N <= T-1, so no
 * padding/multi-block absorption is exercised).
 *
 * state = zeros(T), state[T-1] = ds, state[0..N-1] += in[0..N-1], then one
 * bn254 Poseidon2 permutation; output = state[0]. Verified against the real
 * compiled circuit's witness output by scripts/bench/verify-poseidon2-sponge.mjs.
 */
import { bn254 } from "@taceo/poseidon2";

const PERM = { 2: bn254.t2, 3: bn254.t3, 4: bn254.t4, 8: bn254.t8, 12: bn254.t12, 16: bn254.t16 };

export function poseidon2Sponge(inputs, t, ds) {
  if (!PERM[t]) throw new Error(`unsupported Poseidon2 state size t=${t}`);
  if (inputs.length > t - 1) throw new Error(`single-block sponge needs inputs.length <= t-1 (got ${inputs.length} for t=${t})`);
  const state = new Array(t).fill(0n);
  state[t - 1] = BigInt(ds);
  for (let i = 0; i < inputs.length; i++) state[i] = (state[i] + BigInt(inputs[i])) % bn254Modulus();
  const out = PERM[t].permutation(state);
  return out[0];
}

let _p = null;
function bn254Modulus() {
  if (_p) return _p;
  _p = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  return _p;
}
