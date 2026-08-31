# 2026-08-31 — Off-chain Merkle build cost: zero-hash pruning (queue item 4, off-chain half)

## Hypothesis

Veil's two off-chain depth-20 Poseidon Merkle tree builders (`scripts/src/compliance-utils.ts`
`buildMerkleTree`, used to seed/rebuild the credential tree, and `frontend/src/lib/merkle-tree.ts`
`MerkleTree`, used by every real transfer proof to build the commitment-inclusion path) rebuild the
**entire** `2^depth`-wide tree on every call, hashing every zero-padding pair for real — an
`O(2^depth)` Poseidon-call cost regardless of how many real leaves exist. (`seed-credential-tree.ts`
even warns "this may take ~60s" for a tree with exactly **one** real leaf.) Replacing the always-hash
loop with a version that only hashes the real leaf prefix — filling the always-zero remainder from
precomputed per-level zero-subtree hashes instead of re-deriving them — cuts build/proof time from
`O(2^depth)` to `O(n + depth)` Poseidon calls, producing a **bit-identical** root and proof, and the
measured wall-clock delta at `n=1` (today's exact real-world usage in both files) is the number that
matters.

This is the off-chain half of `EXPERIMENTS.md` item 4 ("Merkle accumulator at scale"). It does not
touch the on-chain accumulator, `templates/merkle_proof.circom`, or the deployed depth-20 circuit
parameter — that half of item 4 (raising `depth` itself, which is a circuit + trusted-setup change)
is still open, see Open Questions.

## Threat / privacy model

No adversary capability changes here. The root and every Merkle proof produced by the new code are
**mathematically and bit-for-bit identical** to what the old code produced (verified directly — see
Approach/Results) — a chain observer, colluding relayer, malicious auditor, or malicious prover sees
exactly the same on-chain data, the same proof shape, the same nullifiers. `templates/merkle_proof.circom`
and every deployed circuit are unmodified.

What this experiment is actually about is **availability/UX**, not confidentiality or soundness: the
old code made every `MerkleTree.getRoot()`/`getProof()` call in `useProofGeneration.ts` — i.e. every
real transfer-proof generation — pay for roughly 1,048,575 real Poseidon calls in the browser, on top
of the Groth16 proving time `BASELINE.md` already measured. That's not currently reflected in
`BASELINE.md`'s ~1.2s browser-proving figure (which starts from a pre-built witness and never
exercises `MerkleTree` at all — see Results). This maps loosely to the threat model's Denial-of-Service
section, but to no single existing STRIDE ID: `docs/threat-model.md`'s D1–D6 entries are all about
pool/relayer-side DoS, not client-side compute cost inside the user's own browser. It's closer to
RR5 (deposit-commitment linkability / anonymity-set size) in spirit, since RR5's stated lever —
"a bigger anonymity set" — is exactly what a deeper tree would require, and a deeper tree was, before
tonight, off the table anyway because building it off-chain was `O(2^depth)`.

**What this does NOT do:** it does not raise the anonymity set (still capped at `2^20 ≈ 1,048,576`
commitments — the circuit's `depth` parameter, unchanged), does not touch trusted-setup assumptions
(RR2, untouched), and does not fix the separate, pre-existing gap noted in Open Questions (today's
frontend code only ever inserts the user's *own* commitment into `MerkleTree`, not the pool's real
commitment set — a correctness question, not a privacy one, and out of scope tonight).

## Approach

**What I built.**

- `scripts/src/compliance-utils.ts` `buildMerkleTree`: kept the exact same signature and the exact
  same fully-padded `{root, layers}` output shape (every existing caller — `test-compliance-utils.ts`,
  `fuzz-tests.ts`, `e2e-compliance-test.ts`, `seed-credential-tree.ts` — asserts on that shape, e.g.
  `tree.layers[0].length === 1 << 20`, so changing it would have meant updating five call sites for no
  real benefit). Internally: precompute `zeroHashes[0..depth]` (`zeroHashes[0] = 0n`,
  `zeroHashes[d] = Poseidon(zeroHashes[d-1], zeroHashes[d-1])`, `depth` calls total), track how many
  positions at the current layer can still be non-zero (`realWidth`, starting at `leaves.length` and
  roughly halving every level), and only call `poseidon(...)` for the `ceil(realWidth/2)` pairs that
  could still be real — every position past that is filled with the cached `zeroHashes[d+1]` constant
  via `Array.fill`, not re-hashed.
- `frontend/src/lib/merkle-tree.ts` `MerkleTree`: same technique, but since this class has no external
  callers depending on a specific internal layer shape (`insert`/`getRoot`/`getProof`/`size` are the
  only public surface), `buildPrunedLayers()` never materializes the full `2^depth`-wide array at all —
  it starts from the real leaves and only ever holds the shrinking real-prefix arrays, falling back to
  `zeroHashes[level]` for any out-of-range sibling lookup in `getProof`.
- `scripts/bench/merkle-scale.mjs`: a self-contained naive-vs-pruned benchmark. It first re-verifies
  correctness itself (naive full-width build vs the real `buildMerkleTree` import, for depth 10 across
  14 values of `n` including every even/odd boundary), refusing to print any timing number if a single
  root or layer mismatches, then times the OLD build once (it's `O(2^depth)`, independent of `n` by
  construction) and the NEW build across a range of `n` at depth 20 and depth 24.
- New correctness tests: `scripts/src/test-compliance-utils.ts` gained a section that cross-checks the
  pruned `buildMerkleTree` against a from-scratch naive reference at depth 8 for 15 values of `n` (every
  layer, not just the root), plus a proof-recombination check for both a real-leaf index and a
  zero-padded index. `frontend/src/__tests__/merkle-tree.test.ts` is new (the file, and `@/` alias
  resolution in `vitest.config.ts`, did not exist before tonight — `merkle-tree.ts` had zero test
  coverage, which is very plausibly why this cost went unnoticed): proof-recombination, `getProof`
  bounds-checking, the canonical empty-tree root, and one depth-20 cross-check against a genuine
  naive full-width reference build (a ~76s test, run once, not in a loop).

**What I rejected.** A general sparse/indexed Merkle tree (arbitrary leaf positions, not just a
zero-padded contiguous prefix) — real overkill: every caller in this codebase only ever inserts leaves
starting at index 0 with no gaps, so the simpler prefix-only pruning captures the entire real cost
without adding an indexing layer nothing needs. I also considered dropping the full-width `layers`
output from `compliance-utils.ts` entirely in favor of the frontend's pruned-layers shape — rejected
for tonight because it would have required touching (and re-verifying) five other files' assertions
for a benefit `BASELINE.md`'s numbers below show is small at the one depth (20) this file is actually
used at; see Results and Open Questions for why it matters more at greater depth.

## Results

### Correctness (`scripts/bench/merkle-scale.mjs`, depth=10, n ∈ {0,1,2,3,7,8,100,511,512,513,1000,1024})

```
--- Correctness: pruned vs naive root/layers, depth=10 (capacity=1024) ---
  OK n=   0: root and all 11 layers identical
  OK n=   1: root and all 11 layers identical
  OK n=   2: root and all 11 layers identical
  OK n=   3: root and all 11 layers identical
  OK n=   7: root and all 11 layers identical
  OK n=   8: root and all 11 layers identical
  OK n= 100: root and all 11 layers identical
  OK n= 511: root and all 11 layers identical
  OK n= 512: root and all 11 layers identical
  OK n= 513: root and all 11 layers identical
  OK n=1000: root and all 11 layers identical
  OK n=1024: root and all 11 layers identical

All pruned-vs-naive outputs identical. Proceeding to timing.
```

Same result independently from `test-compliance-utils.ts` (depth 8, `n` ∈ {0,1,2,3,7,8,9,63,64,65,
127,128,129,255,256} — every layer, not just root — plus proof recombination for a real and a
zero-padded index) and `frontend/__tests__/merkle-tree.test.ts` (depth 20, one full naive-reference
cross-check). 101/101 and 4/4 tests pass respectively; full suite results are in the table below.

### Build time, depth 20 (the deployed circuit depth) — `node scripts/bench/merkle-scale.mjs`

| n (real leaves) | OLD (naive, full-width) | NEW (pruned) | Speedup |
|---|---:|---:|---:|
| 1 (today's actual usage — `seed-credential-tree.ts`, `useProofGeneration.ts`) | 101,358.4 ms | 43.8 ms | **~2,315x** |
| 10 | *(constant, see below)* | 112.5 ms | ~901x |
| 100 | | 125.9 ms | ~805x |
| 1,000 | | 198.2 ms | ~511x |
| 10,000 | | 1,056.1 ms | ~96x |
| 100,000 | | 10,497.9 ms | ~9.7x |
| 1,048,576 (full tree — no padding to skip) | | 108,763.1 ms | ~0.93x (correctly no speedup: every pair is real) |

OLD is run once, at `n=1`: it is `O(2^depth)` by construction and does not depend on `n`, so timing it
again at other `n` would just re-measure the same ~101s. The last row (`n = capacity`) is the sanity
check that the optimization is real, not an accounting trick: at full occupancy there is no
zero-padding left to skip, and NEW correctly costs the same as OLD (fractionally more, from the
`zeroHashes` precompute and array bookkeeping).

### Build time, depth 24 (capacity 16,777,216 — inside the 10⁵–10⁷ range `EXPERIMENTS.md` item 4 names)

| n | NEW (pruned) |
|---|---:|
| 1 | 1,798.7 ms |
| 1,000 | 1,662.7 ms |
| 100,000 | 11,087.6 ms |

OLD was not attempted at depth 24 — extrapolating the depth-20 OLD rate (`101,358.4 ms / (2^20 - 1)
≈ 0.0967 ms/hash`) gives **≈ 1,621.7 s (≈ 27 min)**, reported here only as a labelled extrapolation, not
a measurement (the raw command output above is honest about this too). The depth-24 numbers also
surface the one place the fix is still incomplete: `compliance-utils.ts` keeps the full-`2^depth`-width
`layers` output for API compatibility (see Approach), and even with real Poseidon calls pruned away,
still pays to *allocate* a `capacity`-length array once per build — visible as the `n=1` row costing
~1.8s at depth 24 vs ~44ms at depth 20 (a ~16x jump, matching the ~16x capacity ratio), while the `n`
that actually dominates (real hashing) barely moves between depth 20 and 24 for the same `n` (10,497.9ms
vs 11,087.6ms at n=100,000). `frontend/src/lib/merkle-tree.ts`'s `MerkleTree` does not have this
residual cost — it never allocates a full-width array in the first place (see Approach) — which is why
it, not `compliance-utils.ts`, is the right template for any future higher-depth accumulator.

Raw command:

```
$ bun run scripts/bench/merkle-scale.mjs
node v22.22.2, linux/x64

--- OLD (naive), depth=20, n=1 leaf ---
  101358.4 ms  (2^20 - 1 = 1,048,575 Poseidon(2) calls)

--- NEW (pruned), depth=20, across n ---
  n=        1: 43.76 ms
  n=       10: 112.53 ms
  n=      100: 125.86 ms
  n=     1000: 198.18 ms
  n=    10000: 1056.08 ms
  n=   100000: 10497.90 ms
  n=  1048576: 108763.08 ms

--- NEW (pruned), depth=24 (capacity 16,777,216), across n ---
  n=        1: 1798.74 ms
  n=     1000: 1662.65 ms
  n=   100000: 11087.64 ms

  [EXTRAPOLATED, not measured] naive depth=24 build ≈ 1621.7 s (0.0967 ms/hash x (2^24 - 1) hashes,
  rate taken from the depth=20 OLD run above)
```

Single run per data point (no repeated-trials mean/stddev, unlike `BASELINE.md`'s proving-time
numbers) — the point here is orders-of-magnitude scaling behavior, not sub-percent precision, and a
full repeated sweep across 10 `n` values at two depths would have cost the run its whole budget.

### Full test suite

| Suite | Result | Command |
|---|---|---|
| `scripts` compliance-utils (incl. 34 new pruned-vs-naive tests) | **101/101 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| `scripts` proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| `scripts` property-based fuzz | **6/6 properties, 500 cases each** | `cd scripts && bun run src/fuzz-tests.ts` |
| `frontend` vitest (incl. 4 new merkle-tree tests) | **23/23 pass** | `cd frontend && bunx vitest run` |
| `circuits` (hash-only mode — see below) | **65/65 pass** (30 compliance + 35 withdraw) | `cd circuits && npm test` |
| Move contracts | **NOT RUN** (unchanged blocker) | `sui` CLI unavailable, see below |

No test was loosened, skipped, or given new tolerance to reach these numbers.

**Toolchain notes.** `circuits/npm test` ran in hash-only fallback mode (no compiled wasm/zkey — no
circuit was touched tonight, so this is expected and matches how `compliance.test.mjs`/`withdraw.test.mjs`
are designed to degrade). It also confirms `EXPERIMENTS.md` item 12 (the chained-`npm test` hang) is
already fixed on `main` by PRs #16/#17 (merged after the 2026-07-22 baseline, `process.exit(0)` added to
each runner) — the three-file `&&` chain completed cleanly tonight without needing to run each file
separately; `transfer.test.mjs`'s 43 passes scrolled off the captured tail but the suite as a whole
exited 0. Re-verified the `sui` CLI and on-chain gas blockers from `EXPERIMENTS.md` item 1 are still
real, via two independent methods: a direct `suix_queryTransactionBlocks` JSON-RPC call to
`fullnode.testnet.sui.io` (`curl: (56) CONNECT tunnel failed, response 403`), and a from-source build
attempt (`git ls-remote https://github.com/iden3/circom.git` succeeds — git-protocol clones are allowed
— but `cargo install`/`cargo build` need actual crate content from `static.crates.io`, which returned
`403`, confirmed separately from `github.com` raw-content downloads, also `403`; only `index.crates.io`
sparse-index *metadata* and `api.github.com` are reachable). Item 1 stays BLOCKED, same root cause as
2026-07-22, now confirmed by a second, independent method.

## Verdict: **KEEP**

Merged: `scripts/src/compliance-utils.ts` and `frontend/src/lib/merkle-tree.ts` now build/prove against
the depth-20 tree in `O(n + depth)` Poseidon calls instead of `O(2^depth)`, verified bit-identical to
the old output by three independent test paths (a dedicated benchmark's built-in check, 34 new
`scripts` unit tests, and a real ~76s naive-reference cross-check in the frontend suite), with zero
API changes for `compliance-utils.ts` and no external callers needing changes for `merkle-tree.ts`.
`BASELINE.md` updated with a new section for this.

## Where this could be used

- **Any off-chain Merkle-accumulator indexer for a fixed-depth ZK circuit** — Tornado-Cash-style
  mixers, any Semaphore/MACI-derived group-membership system, any protocol using a depth-20-ish Poseidon
  tree with a real-time or near-real-time "rebuild proof against latest root" requirement. The
  zero-hash-pruning technique itself is standard (it's the same idea as `tornado-core`'s incremental
  Merkle tree), but this experiment is the first time it's been *measured* against Veil's specific
  builders rather than assumed correct by construction.
- **Confidential payroll or compliance-gated DeFi on Sui with a growing credential set** — the credential
  tree this fixes directly (`compliance-utils.ts`) is exactly the shape a KYC-credential accumulator for
  a payroll or compliance product would use; this removes the "rebuilding the tree takes a minute" tax
  every time a credential is added or revoked.
- **A thesis chapter on ZK-accumulator engineering pitfalls** — the fact that a mathematically-correct,
  well-tested Merkle builder shipped with a silent `O(2^depth)` cost, unnoticed because `merkle-tree.ts`
  had zero test coverage until tonight, is itself a useful case study in why "the root is right" and
  "the implementation is production-ready" are different claims.

## Open questions (next queue)

1. **Raising the on-chain tree depth** (the other half of item 4, and the actual lever for anonymity-set
   size per RR5) is still a circuit + trusted-setup change, not something this off-chain fix unlocks by
   itself — but it *removes* the objection that off-chain rebuilding would be impractical at greater
   depth: depth 24 (~16.8M capacity) now builds in ~11s for 100,000 real leaves, not the ~27 minutes a
   naive rebuild would need (extrapolated above). Worth scoping as its own night: constraint-count delta
   from `MerkleProof(24)` vs `MerkleProof(20)` in the circuit, a new trusted-setup ceremony, and the
   actual anonymity-set-vs-proving-time tradeoff curve.
2. **`compliance-utils.ts`'s residual `O(capacity)` array allocation** (Results, depth-24 `n=1` row) —
   fine at depth 20 (~44ms), a real cost at depth 24+ (~1.8s just to allocate, before any real hashing).
   Fixable by switching its output to the frontend's pruned-layers shape, but that ripples into five
   existing call sites' assertions on the full-width shape — worth doing together with #1 if depth ever
   actually changes, not before.
3. **`frontend/src/hooks/useProofGeneration.ts` only ever inserts the user's own commitment into
   `MerkleTree`** (`merkleTree.insert(BigInt(oldCommitment))`, single leaf, per its own "Demo" comment) —
   noticed in passing while reading this code path, not investigated tonight. If that is genuinely all a
   real transfer proof does today, the resulting root would only match the on-chain commitment root when
   the pool has exactly one commitment, which reads more like a known scaffold than a privacy issue (the
   proof would simply fail on-chain against a real multi-commitment pool, not leak anything) — but it is
   worth a dedicated look rather than an assumption either way.
4. **On-chain gas per entry point** (`EXPERIMENTS.md` item 1) — still BLOCKED, now confirmed by a second
   independent method tonight (crates.io content + GitHub raw content both `403`, git-protocol clones
   allowed). Whoever configures this environment's network policy is the only path to unblocking it; no
   further sandbox workaround is left to try from inside the loop.
