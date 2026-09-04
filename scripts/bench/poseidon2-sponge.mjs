/**
 * poseidon2-sponge.mjs — JS-side mirror of circuits/bench/lib/poseidon2_compress.circom's
 * sponge construction, built on @taceo/poseidon2's raw permutations (the same team's
 * circom templates are what circuits/bench/*_poseidon2.circom use — see that library's
 * README: "Compatible with the HorizenLabs parameter script and the Rust taceo-poseidon2
 * crate", i.e. an independently cross-checked parameter set, not something invented here).
 *
 * Only handles the one-permutation case (nVals <= T - 1), which is all six bench circuits
 * ever need (see the width table in docs/research/2026-09-04-poseidon2-constraints.md).
 */
import { bn254 } from "@taceo/poseidon2";

const PERM = { 2: bn254.t2, 3: bn254.t3, 4: bn254.t4, 8: bn254.t8, 12: bn254.t12, 16: bn254.t16 };

/** Mirrors Poseidon2CompressTagged(nVals, T, tag) in poseidon2_compress.circom exactly. */
export function poseidon2CompressTagged(vals, T, tag) {
  const nVals = vals.length;
  if (nVals < 1 || nVals > T - 1) throw new Error(`nVals=${nVals} does not fit rate T-1=${T - 1}`);
  const perm = PERM[T];
  if (!perm) throw new Error(`unsupported T=${T}`);

  const ds = BigInt(tag) + 1009n * BigInt(nVals) + 1000003n * BigInt(T);
  const state = new Array(T).fill(0n);
  state[T - 1] = ds;
  for (let i = 0; i < nVals; i++) state[i] += BigInt(vals[i]);

  return perm.permutation(state)[0];
}

/** Mirrors MerkleLevelPoseidon2(MERKLE_TAG) — a 2-value compression at T=3. */
export function merkleLevelPoseidon2(left, right, merkleTag) {
  return poseidon2CompressTagged([left, right], 3, merkleTag);
}

export function merkleRootPoseidon2(leaf, pathElements, pathIndices, merkleTag) {
  let node = leaf;
  for (let i = 0; i < pathElements.length; i++) {
    const sibling = pathElements[i];
    const [l, r] = pathIndices[i] === 0n ? [node, sibling] : [sibling, node];
    node = merkleLevelPoseidon2(l, r, merkleTag);
  }
  return node;
}
