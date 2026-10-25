# 2026-10-25 — Where the transfer circuit's constraints actually go, and a K-ary Merkle path (queue #2, re-scoped)

**Verdict: PARK** — measured win on a standalone prototype; not integrated (Move tree, indexer and
SDK untouched; on-chain gas for wider Poseidon is UNMEASURED because gas is still BLOCKED).

## Why not queue #1 (gas)
Re-attempted first. `sui` is not installed; GitHub releases/crates.io return 403 from the egress
proxy, and `fullnode.testnet.sui.io` is refused (`CONNECT tunnel failed, response 403`,
proxy status: `connect_rejected`). So gas is blocked by **network policy of the sandbox**, not by
tooling effort. It needs an environment that allows `fullnode.*.sui.io` / GitHub release downloads.
Falling through to #2, whose premise turned out to be wrong (below).

## Hypothesis
The queue claimed "four Poseidon instances dominate" transfer's constraints. Measured, that is
false: transfer has **24** Poseidon instances, 20 of them in the Merkle path. Hypothesis: replacing
the binary depth-20 path with a 4-ary depth-10 path (same 2^20 capacity) cuts transfer non-linear
constraints by >25% and Node proving time by >10%, with no change to public inputs.

## Threat / privacy model
Adversary: chain observer (and relayer) trying to learn which leaf was spent. Public inputs
are byte-identical (7 public signals: same set); the position one-hot and siblings are private, so
the observer learns exactly what they learn today (root, nullifier, commitments). Anonymity set is
unchanged at 2^20 (8-ary d7 gives 2^21, a free x2). Soundness argument for `KaryMerkleProof`: each
level enforces `onehot_j ∈ {0,1}` and `Σ onehot = 1`, so exactly one position j* holds the running
node; `child_j = sib_j + onehot_j·(node − sib_j)` equals `node` at j* and `sib_j` elsewhere; the
Poseidon(K) output is bound level by level to `merkleRoot`. Collision resistance of Poseidon(K)
gives binding to the real tree. Known benign property: the sibling slot at j* is unconstrained
(proof is malleable in a dead witness slot; Groth16 proofs are already re-randomisable and
nullifiers do not depend on it) — verified below (`deadSlotStillAccepted: true`).
**Not defended / residual:** Poseidon(4..8) security margins differ from Poseidon(2) and
circomlib's t=5/t=9 parameters have had less cryptanalysis than t=3; trusted setup (RR2) and
everything else in `docs/threat-model.md` is unchanged. STRIDE: Tampering/Spoofing of membership
(same entries as the binary path); no new Information-disclosure surface.
Assumptions: Poseidon CR at larger arity; Groth16/BN254 as before.

## Approach
`circuits/experiments/kary_merkle.circom` + `transfer_kary.circom` (copy of `transfer.circom`
with the path swapped). Harness: `scripts/bench/kary-merkle.mjs` (compile, local dev ptau 2^15,
setup, 10 timed proves after warm-up, verify, negative tests); attribution script:
`scripts/bench/constraint-breakdown.sh`. Rejected before building: Poseidon2 (no circom
implementation in circomlib, and `sui::poseidon` on-chain only offers the original Poseidon, so a
hash swap breaks Move/circuit agreement — a K-ary tree stays inside Sui's native hash);
sparse-Merkle/other accumulators (separate queue items).

## Results
Toolchain differs from 2026-07-22: circom 2.2.3 via the `circom2` npm WASM build (circom 2.2.2
native could not be built here), different machine load — **absolute times are not comparable with
BASELINE.md; compare rows within this table only.**

Constraint attribution (`scripts/bench/constraint-breakdown.sh`, raw output in the PR):

| Part of transfer.circom | non-linear |
|---|---|
| MerkleProof(20) (20×Poseidon(2) = 4860 + 60 mux/bool) | 4920 |
| 3×Poseidon(4) + 1×Poseidon(3) (commitments, nullifier, txAmountHash) | 1164 |
| 4×Num2Bits(64)+GreaterThan(64)+LessEqThan(64) | 386 |
| **Sum** | **6470** (= full-circuit count, exact) |

Poseidon is 93% of non-linear constraints, but 76% is the Merkle path alone.

| config | non-linear | linear | zkey bytes | prove mean ms (σ) | verifies |
|---|---|---|---|---|---|
| binary d20 (production transfer.circom) | 6470 | 7141 | 6001020 | 992.5 (19.4) | true |
| 2-ary d20, new template (control) | 6490 | 7221 | 6035660 | 984.4 (36.1) | true |
| 4-ary d10 (2^20 leaves) | 4630 (−28.4%) | 6101 | 4921580 | 866.5 (64.2) (−12.7%) | true |
| 8-ary d7 (2^21 leaves) | 4497 (−30.5%) | 7135 | 5205684 | 877.5 (55.2) | true |
| 16-ary d5 (2^20 leaves) | 4770 | 9221 | 5995020 | 1012.7 (42.0) | true |

Negative tests (all four k-ary configs): wrong sibling, all-ones position, all-zero position,
non-boolean position summing to 1 → **rejected**; ignored dead slot altered → still verifies.
Raw JSON lines from the run are in `docs/research/2026-10-25-kary-merkle-transfer.raw.txt`.
Existing suites (hash-only mode; build artifacts absent): transfer 43/43, compliance 30/30,
withdraw 35/35. **Not run:** Move tests (no `sui`), full-circuit-mode circuit tests. No production
file changed.

## Verdict: PARK
4-ary is the sweet spot (8-ary barely better, 16-ary loses on linear constraints). Blocked on:
(1) on-chain Poseidon(4) gas vs Poseidon(2)×2 per insert — needs gas measurement (queue #1);
(2) Move `merkle_tree` insertion, indexer and SDK rewrite for K-ary; (3) a ≥50-sample rerun
because σ is ~7% of the mean (−12.7% is real-direction, not precisely sized).

## Where this could be used
Any Sui/Move shielded pool using circomlib Poseidon trees: a Zcash-Sapling-style note pool
or a confidential payroll with a t-of-n auditor board, where the membership proof dominates the
prover bill; mobile wallet proving (thesis chapter on client-side proving cost).

## Open questions
- Move-side gas of K-ary incremental insert and of `poseidon_bn254` with 4 inputs.
- Compliance circuit has the same depth-20 path: expected analogous saving (not measured).
- Indexer cost for K-ary paths (sibling sets are 3 per level, 30 vs 20 field elements).
- Poseidon t=5 parameters: any cryptanalysis concern vs t=3?
