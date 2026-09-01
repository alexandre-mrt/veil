/**
 * poseidon2-hash.mjs — JS-side companion to circuits/poseidon2-experiment/poseidon2_hash.circom.
 *
 * Builds a `poseidon(inputsArray) -> bigint` function with the exact same interface
 * scripts/bench/witnesses.mjs expects (matching circomlibjs's buildPoseidon() output shape
 * closely enough that WITNESS_BUILDERS can be reused unmodified), but backed by
 * @taceo/poseidon2's BN254 permutation instead of circomlib's original Poseidon.
 *
 * Same sponge convention as the circom wrapper: state[0] = capacity (0),
 * state[1..nInputs] = inputs, zero-pad up to the next natively supported width
 * (2, 3, 4, 8, 12, 16) when nInputs+1 isn't one already, squeeze state[0].
 *
 * EXPERIMENTAL — see circuits/poseidon2-experiment/README.md for the padding caveat.
 */
import { bn254 } from "@taceo/poseidon2";

const PERMS = { 2: bn254.t2, 3: bn254.t3, 4: bn254.t4, 8: bn254.t8, 12: bn254.t12, 16: bn254.t16 };

function nextSupportedWidth(t) {
  if (PERMS[t]) return t;
  if (t === 5 || t === 6 || t === 7) return 8;
  if (t === 9 || t === 10 || t === 11) return 12;
  if (t === 13 || t === 14 || t === 15) return 16;
  throw new Error(`no supported Poseidon2 width for state size ${t}`);
}

/** poseidon2(inputs: bigint[]) -> bigint, matching Poseidon2Hash(nInputs) in the circuit. */
export function poseidon2(inputs) {
  const nInputs = inputs.length;
  const t = nInputs + 1;
  const actualT = nextSupportedWidth(t);
  const state = new Array(actualT).fill(0n);
  for (let i = 0; i < nInputs; i++) state[i + 1] = BigInt(inputs[i]);
  const out = PERMS[actualT].permutation(state);
  return out[0];
}
