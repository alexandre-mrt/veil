# 2026-09-25 — Poseidon / Merkle constraint isolation (queue item #2, alternate form)

## Hypothesis

Of the non-linear R1CS constraints in `transfer.circom` and `compliance.circom`, more than half
are attributable to the single depth-20 `MerkleProof` component (20 sequential `Poseidon(2)`
calls) rather than to the circuits' top-level identity/nullifier/leaf Poseidon calls — meaning a
future Poseidon2 migration's highest-leverage target is the Merkle-path hasher specifically, not
"Poseidon" as an undifferentiated whole. This experiment measures the exact split, isolating each
distinct Poseidon instantiation (`Poseidon(2)`, `(3)`, `(4)`, `(5)`, and `MerkleProof(20)`) as its
own standalone circuit and diffing the predicted sum against each real circuit's actual compiled
constraint count.

This is queue item #2's parenthetical alternate form ("re-deriving the exact non-linear-constraint
contribution per Poseidon instance from the current baseline"), chosen over the full
Poseidon(-original)-to-Poseidon2 swap because a verifiable Poseidon2 circom implementation is not
reachable this session — see Approach and Verdict.

## Threat / privacy model

No protocol code changed — `transfer.circom`, `withdraw.circom`, and `compliance.circom` are
byte-for-byte unmodified (verified: their compiled constraint counts below exactly match the
2026-07-22 baseline). This is a measurement experiment over the existing, audited circuits, not a
new attack surface. The relevant framing, as in the 2026-07-22 report, is who relies on the numbers
being honest:

- **This research loop**, on the night it attempts a real Poseidon2 migration: that experiment's
  "expected win" claim needs a real baseline of how many constraints are actually up for grabs.
  Without this breakdown, "Poseidon2 cuts constraints" is directionally true but has no target —
  today's finding is that ~76-81% of `transfer.circom`'s and `compliance.circom`'s non-linear
  constraints sit in the 20-level Merkle walk, not in the four-or-fewer top-level identity/
  nullifier hashes a naive reading of the circuit's "Poseidon instances" comment block would
  suggest optimizing first.
- **A future engineer sizing a deeper Merkle tree** (queue item #4, RR5's anonymity-set trade-off):
  this experiment derives the exact marginal cost of one additional tree level (246 non-linear
  constraints), which is the number that trade-off needs and did not exist as a measured quantity
  before tonight.

What this does **not** establish: whether Poseidon2 (or any alternative hash) is sound as a drop-in
replacement — no Poseidon2 circuit was built or evaluated for correctness tonight (see Approach).
It says nothing about proving-*time* impact directly (only constraint count, which correlates with
but is not identical to prover wall-clock time — `BASELINE.md`'s existing proving-time numbers are
the closest available proxy). It maps to no new STRIDE entry: it's supporting analysis for a future
entry (a Poseidon2 migration, if one happens, would need its own S2/soundness re-review), and it
sharpens the trade-off already tracked at RR5 (Merkle accumulator / anonymity-set sizing) with a
concrete per-level cost.

Assumptions unchanged from `docs/threat-model.md` and the 2026-07-22 baseline: Groth16 soundness
under BN254 discrete log, dev-only trusted setup (RR2), original (not "2") Poseidon's standard
security parameters as shipped by `circomlib`.

## Approach

**What I built.** `scripts/bench/poseidon-isolation.mjs` plus five one-component circuits under
`scripts/bench/poseidon-isolation/circuits/`: `poseidon_2.circom`, `poseidon_3.circom`,
`poseidon_4.circom`, `poseidon_5.circom` (each `component main = Poseidon(N)`), and
`merkle_20.circom` (`component main = MerkleProof(20)`, the exact template
`transfer.circom`/`compliance.circom` use for membership proofs). The script compiles all five,
plus fresh, byte-for-byte-unmodified copies of `transfer.circom`, `withdraw.circom`, and
`compliance.circom`, reads each circuit's `component X = Poseidon(N)` / `MerkleProof(depth)` count
directly from the real circuit source, and computes `predicted = Σ(instance count × isolated
constraint count)` against each real circuit's actual total, printing the gap as "glue" (range
checks, comparators, epoch/threshold logic — everything that isn't a Poseidon or Merkle call).

**Toolchain gap hit, and the workaround.** This session's egress policy is measurably tighter than
the one the 2026-07-22 baseline ran under: `github.com` (release binaries), `static.crates.io`
(`cargo install`/`cargo build` crate downloads — `index.crates.io` alone, which only serves the
package index, is reachable), every public Sui RPC/explorer host tried (`fullnode.testnet.sui.io`,
`api.testnet.sui.io`, `rpc.ankr.com`, `sui-testnet.blockvision.org`,
`sui-testnet-rpc.publicnode.com`, `sui-testnet.nodeinfra.com`, `suiscan.xyz`, `suivision.xyz`), and
`storage.googleapis.com` (the Hermez `pot15` Powers-of-Tau file `circuits/scripts/compile.sh`
downloads for trusted setup) all returned `403` through the agent proxy tonight — i.e. an
organization-policy denial per `/root/.ccr/README.md`, not a transient failure, so none were
retried. That means **last night's exact toolchain path (build `circom` from source via `cargo`,
fetch the Hermez ptau) does not reproduce in this environment tonight.** Only the npm registry,
PyPI, the crates.io sparse index, jsr.io, and the Go module proxy are reachable.

I found a workaround entirely within that allowlist: **`circom2`** (npm, `0.2.23`) ships circom
2.2.3 compiled to WASM. I verified it byte-for-byte against last night's native-binary numbers
before trusting it for anything: compiling `transfer.circom` fresh with `circom2` reproduces
*exactly* `13,611` constraints / `6,470` non-linear / `7,141` linear / `13,632` wires — the same
figures `BASELINE.md` recorded from the native `circom` 2.2.2 build. `circom2` is now the working,
reachable circuit compiler for this loop; I did not update `BASELINE.md`'s toolchain line since
that baseline is unaffected (identical output), but future nights needing to compile circuits
should reach for `circom2` first rather than repeat last night's from-source build attempt against
hosts this session's policy blocks.

The Powers-of-Tau blocker is a second-order casualty of the same policy tightening: because
`storage.googleapis.com` is now blocked too, I could not run the real-Groth16 variant of the
existing circuit test suite tonight (needs a compiled zkey from a real or locally-generated trusted
setup) — see Results. I did not attempt a local from-scratch `snarkjs powersoftau new` ceremony to
route around it; that's real, useful follow-up work but out of scope for tonight's one hypothesis.

**What I rejected.** A full Poseidon-to-Poseidon2 circuit swap (the literal reading of queue item
#2) — rejected for tonight specifically because no Poseidon2 circom implementation is reachable
through this session's allowlist (`poseidon2-circom` and `circom-poseidon2` don't exist on npm;
`@zk-kit/circuits` and `circomlib`'s latest npm releases were checked and contain only
original-Poseidon circuits; the canonical Poseidon2 round constants and reference test vectors live
in papers/repos on now-blocked hosts). Hand-deriving Poseidon2's constants and MDS/linear-layer
matrices from the published equations without a reachable reference implementation to check the
output against was explicitly rejected: a mis-derived permutation would produce a circuit that
compiles and "works" (accepts valid witnesses, rejects invalid ones under the wrong permutation)
while being silently non-standard and unaudited — exactly the kind of unverifiable cryptography this
loop's "every number from a command actually run" rule exists to prevent. Isolating the *existing,
audited* Poseidon's constraint contribution is the honest version of this question available
tonight.

## Results

### Isolated component constraint counts (fresh `circom2` compiles, non-linear R1CS)

| Component | Non-linear | Linear | Wires |
|---|---|---|---|
| `Poseidon(2)` | 243 | 274 | 520 |
| `Poseidon(3)` | 264 | 341 | 609 |
| `Poseidon(4)` | 300 | 436 | 741 |
| `Poseidon(5)` | 324 | 511 | 841 |
| `MerkleProof(20)` (20× `Poseidon(2)` + 20× `MultiMux1(2)`) | 4,920 | 5,480 | 10,422 |

`MerkleProof(20)` cost per level: `4,920 / 20 = 246.0` non-linear constraints — `243` from the
`Poseidon(2)` hash itself plus `3.0` from the `MultiMux1(2)` left/right selector.

### Predicted (Poseidon-only) vs actual non-linear constraints, per real circuit

| Circuit | Composition | Predicted (Poseidon-only) | Actual (fresh compile) | Non-Poseidon "glue" | Poseidon share |
|---|---|---|---|---|---|
| `transfer.circom` | 1×`MerkleProof(20)` + 3×`Poseidon(4)` + 1×`Poseidon(3)` | 4,920 + 900 + 264 = **6,084** | **6,470** | 386 (6.0%) | **94.0%** |
| `withdraw.circom` | 3×`Poseidon(4)` + 1×`Poseidon(2)` (no Merkle proof — see below) | 900 + 243 = **1,143** | **1,465** | 322 (22.0%) | **78.0%** |
| `compliance.circom` | 1×`MerkleProof(20)` + 1×`Poseidon(5)` + 2×`Poseidon(3)` | 4,920 + 324 + 528 = **5,772** | **6,057** | 285 (4.7%) | **95.3%** |

`withdraw.circom`'s actual total (1,465) and its instance composition exactly reproduce
`BASELINE.md`'s 2026-07-22 figures, confirming the circuit is unmodified. `withdraw.circom` has no
`MerkleProof` component by design — its header comment states withdrawals reveal the spent
commitment on-chain rather than proving anonymity-set membership, so it never pays the 4,920-
constraint Merkle cost the other two circuits do; correspondingly the "glue" (range checks,
comparators) makes up a much larger share (22%) of its smaller total.

Raw command and output (abbreviated — full output in the PR's CI log / reproducible via the command
below):

```
$ node scripts/bench/poseidon-isolation.mjs
=== Poseidon isolation benchmark (circom2 0.2.23 / circom 2.2.3, WASM) ===

--- Poseidon(2) --- non-linear constraints: 243, linear constraints: 274, wires: 520
--- Poseidon(3) --- non-linear constraints: 264, linear constraints: 341, wires: 609
--- Poseidon(4) --- non-linear constraints: 300, linear constraints: 436, wires: 741
--- Poseidon(5) --- non-linear constraints: 324, linear constraints: 511, wires: 841
--- MerkleProof(20) --- non-linear constraints: 4920, linear constraints: 5480, wires: 10422
--- transfer.circom (actual) --- non-linear constraints: 6470, linear constraints: 7141, wires: 13632
--- withdraw.circom (actual) --- non-linear constraints: 1465, linear constraints: 1593, wires: 3058
--- compliance.circom (actual) --- non-linear constraints: 6057, linear constraints: 6686, wires: 12762

=== Predicted vs actual non-linear constraints ===

transfer:
  composition: 1x Poseidon(3) (264 each) + 3x Poseidon(4) (300 each) + 1x MerkleProof(20) (4920 each)
  predicted Poseidon-only sum: 6084
  actual total non-linear:     6470
  non-Poseidon glue:           386 (6.0%)
  Poseidon share:               94.0%

withdraw:
  composition: 1x Poseidon(2) (243 each) + 3x Poseidon(4) (300 each)
  predicted Poseidon-only sum: 1143
  actual total non-linear:     1465
  non-Poseidon glue:           322 (22.0%)
  Poseidon share:               78.0%

compliance:
  composition: 2x Poseidon(3) (264 each) + 1x Poseidon(5) (324 each) + 1x MerkleProof(20) (4920 each)
  predicted Poseidon-only sum: 5772
  actual total non-linear:     6057
  non-Poseidon glue:           285 (4.7%)
  Poseidon share:               95.3%

Per-Merkle-level cost (one MerkleProof(20) step):
  4920 / 20 = 246.0 non-linear constraints/level
  (Poseidon(2) alone: 243; MultiMux1(2) selector overhead: 3.00/level)
```

Reproduce: `cd scripts/bench && npm install && node poseidon-isolation.mjs` (installs `circom2` +
`circomlib` locally; no other network access required).

### Test suite

Attempted the full suite from `README.md`'s "Test counts" section (this repo has no `CLAUDE.md`).
No circuit, Move, or frontend source was modified this session — only new files under
`scripts/bench/`.

| Suite | Result | Command | Note |
|---|---|---|---|
| `transfer.circom` | **43/43 pass** | `cd circuits && node --experimental-vm-modules test/transfer.test.mjs` | **HASH-ONLY mode** (constraint simulation), not real Groth16 — see below |
| `withdraw.circom` | **35/35 pass** | same, `test/withdraw.test.mjs` | HASH-ONLY mode |
| `compliance.circom` | **30/30 pass** | same, `test/compliance.test.mjs` | HASH-ONLY mode |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` | Full run, no blockers |
| Compliance utils (credential leaf, Merkle builder) | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` | Full run; the depth-20 `buildMerkleTree` case pads to 2^20 leaves and took several minutes of CPU-bound JS Poseidon hashing — slow, not stuck |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bun install && bun run test` | `npm install` hit an unrelated npm/arborist bug (`Cannot read properties of null (reading 'edgesOut')`) resolving peer deps in this frontend's tree; `bun install` (already this repo's documented frontend tool) worked cleanly |
| Move contracts | **NOT RUN** (unchanged blocker) | `cd contracts && sui move test` | No `sui` CLI reachable — same root cause as `BASELINE.md`'s gas-measurement blocker |

**Why circuit tests ran HASH-ONLY, not real Groth16, tonight:** each circuit test file
auto-detects compiled `build*/`  wasm+zkey artifacts and falls back to a hash-only constraint
simulation when they're absent (see `test/transfer.test.mjs` lines 1-6, 133). Producing those
artifacts requires a Groth16 trusted setup, which requires the Powers-of-Tau file — blocked
tonight per the toolchain section above (`storage.googleapis.com` returns 403). This is a real,
inherited coverage gap, not a loosened test: the 2026-07-22 baseline ran these same 108 tests in
full Groth16 mode when the ptau download worked; tonight's tighter egress policy took that away.
No test was skipped, modified, or given new tolerance — the fallback is the test file's own
pre-existing, honest behavior when its prerequisite artifacts are missing.

## Verdict: **KEEP**

`scripts/bench/poseidon-isolation.mjs` is a real, reusable, reproducible measurement — one command,
zero network dependency beyond `npm install`, and its two most-isolated numbers (`Poseidon(2)` =
243 constraints, one Merkle level = 246 constraints) cross-validate against the baseline's own
totals via the "predicted vs actual" diff, which lands within 5-22% for all three circuits (the gap
being exactly the non-Poseidon logic, which is itself now a measured quantity per circuit rather
than an unknown remainder).

The literal queue item #2 (a measured Poseidon2 constraint/proving-time *delta*) is **not**
answered tonight and is **not** claimed to be — no Poseidon2 circuit exists in this repo. That
remains **PARKed**, blocked specifically on network access to a canonical, verifiable Poseidon2
circom reference implementation (or reference test vectors to check a hand-derived one against) —
re-queued below as a narrower, better-informed version of itself.

## Where this could be used

- **Any Circom protocol whose dominant cost is a fixed-depth Merkle membership proof** (this class
  covers most UTXO-style shielded-pool designs, not just Veil's transfer/compliance circuits): the
  per-level cost derivation here (`Poseidon(2) constraints + O(1) selector overhead` per level) is
  the right first question before optimizing anything else, since — as measured tonight — it can
  dominate 75-95% of total non-linear constraints, dwarfing every other design choice in the
  circuit.
- **Sizing an anonymity set against a proving-time budget** (a thesis chapter or a protocol
  designer choosing Merkle depth for a target anonymity-set size, e.g. depth 24 for ~16.7M
  addressable leaves instead of depth 20's ~1.05M): `246 constraints/level × Δdepth` is now a
  concrete, derived formula rather than a guess, directly informing RR5 in `docs/threat-model.md`.
- **Prioritizing a Poseidon2 migration budget**: knowing that the Merkle-path hasher alone is
  76-81% of two circuits' constraint cost means a partial migration (Poseidon2 for just the
  `MerkleProof` template's internal hasher, leaving the four-or-fewer top-level identity/nullifier
  Poseidon(N) calls on original Poseidon) would likely capture most of the available win at a
  fraction of the audit surface of a protocol-wide swap — a scoping option this data makes
  visible that wasn't visible before tonight.

## Open questions (next queue)

1. **Poseidon2 for the Merkle-path hasher specifically** (narrower than the old item #2): swap only
   `templates/merkle_proof.circom`'s `Poseidon(2)` for a verified Poseidon2 arity-2 permutation,
   leaving the top-level identity/nullifier hashes untouched. Still blocked on finding (or being
   given network access to fetch) a canonical, checkable Poseidon2 circom reference — this is now
   the single most valuable blocked item in the queue given tonight's 76-81% finding.
2. **This session's egress policy is measurably tighter than 2026-07-22's.** `github.com`,
   `static.crates.io`, `storage.googleapis.com`, and every Sui RPC/explorer host tried are now
   blocked, vs. only Sui-related hosts being blocked last time. On-chain gas measurement (queue
   item #1) is BLOCKED for a second consecutive night for the same structural reason, now joined by
   the ptau download. This isn't fixable by retrying or by a different tool — it needs either a
   broader host allowlist from whoever administers this sandbox, or artifacts (a ptau file, a `sui`
   binary) made available through an already-allowed channel (e.g. published to npm, or vendored
   into the repo itself if small enough and license-appropriate).
3. Given the ptau blocker, could `snarkjs powersoftau new` + local `contribute`/`beacon` (a
   from-scratch, non-Hermez trusted setup, computed entirely locally with no network call) unblock
   real-Groth16 circuit testing and future proving-time benchmarking without needing any blocked
   host? Not attempted tonight (out of scope for one hypothesis) — good candidate for a lighter
   night, and would also de-risk this loop against the Hermez ptau URL becoming unreachable again.
4. `circom2` (npm, WASM) is now this loop's verified, reachable circuit compiler — should
   `circuits/package.json` adopt it as a `devDependency` (alongside or instead of documenting a
   native `cargo install circom` in `README.md`'s prerequisites), given tonight's finding that the
   native-build path is not reliably reachable in this sandbox?
