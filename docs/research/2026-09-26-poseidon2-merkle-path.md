# 2026-09-26 — Poseidon2 for the Merkle authentication path (queue item #2, part 1)

## Hypothesis

`transfer.circom`'s depth-20 Merkle membership check (C0) calls `Poseidon(2)` — circomlib's
sponge-mode Poseidon, state width t=3 — once per tree level, 20 times per proof. That is by far
the highest-multiplicity Poseidon call in the circuit (the other four named instances — two
commitment hashes, the nullifier, the tx-amount hash — run once or twice each). Replacing it with
Poseidon2 in *compression mode* (t=2, no unused capacity element, collision resistance from a
Miyaguchi–Preneel feed-forward instead) reduces `transfer.circom`'s non-linear R1CS constraint
count by a double-digit percentage, without changing any other constraint, the public/private
input layout, or the Groth16 proof format.

This is queue item #2's narrower, safely-scoped half: not "swap every Poseidon instance to
Poseidon2" (the other three instances need t=4/t=5 arities and a different compression
convention that wasn't cross-checked tonight — see Open questions), but the one swap that (a)
touches the highest-multiplicity hasher and (b) has an established, citable construction to copy
rather than invent.

## Threat / privacy model

**Adversary: a malicious prover** trying to get the on-chain `sui::groth16` verifier to accept a
transfer for a commitment that isn't actually in the Merkle tree (i.e., break C0's soundness).
What they can do: choose any private witness (leaf, path elements, path indices) they like, as
long as the resulting proof verifies against the public `merkleRoot`. What they can't do: control
`merkleRoot` (public input, taken from `pool::Pool`'s on-chain accumulator) or the verifying key
(timelocked, `verifier.move`).

Soundness of the swap rests on: (1) the Poseidon2 permutation being a good pseudorandom
permutation over the BN254 scalar field — same class of assumption the existing Poseidon
instances already rely on, not a new one; (2) the Miyaguchi–Preneel feed-forward
(`out = Perm([left, right])[0] + left`) making the compression function collision-resistant even
though the state width (t=2) equals the input width, with no spare capacity element for domain
separation the way sponge mode has. Without the feed-forward, an attacker who can invert the
permutation's final linear layer could find a second (leaf, path) pair producing the same root
purely from the permutation being a bijection; the feed-forward addition is what removes that
attack (this is precisely why the Poseidon2 paper, eprint 2023/323, treats "compression mode" as
a distinct mode from "sponge mode" rather than sponge-with-t=n).

**What this does NOT defend against** — the residual surface:
- **No cross-check against a second, independently-parameterized Poseidon2 implementation.**
  `@taceo/poseidon2` (JS) and `@taceo/circom-lib`'s `poseidon2.circom` are the same publisher,
  explicitly claiming parity with each other and with the Rust `taceo-poseidon2` crate (same
  HorizenLabs-script-derived round constants). If that one parameter derivation has a shared bug,
  today's tests would not catch it. A second, independently-sourced implementation (e.g. a
  from-scratch derivation from the HorizenLabs sage script) was not attempted tonight — see Open
  questions.
- **No new anonymity-set analysis.** This changes *how* a Merkle node hash is computed, not the
  tree's depth, the set of things that are hashed, or which values are public vs. private. The
  anonymity-set size (2^20 commitments, RR5 in `docs/threat-model.md`) is unchanged.
- **No change to the malicious-auditor, colluding-relayer, or statistical-deanonymizer threat
  classes.** C0 is a membership proof; it says nothing about who submitted the transaction or who
  can decrypt compliance ciphertexts.
- **No post-quantum improvement.** Same BN254 discrete-log-hardness assumption as before, same
  Groth16 proof system, same non-PQ story as `docs/threat-model.md`'s residual risks already
  document.

**Chain-observer leakage — the honest answer is "none, either way."** The Groth16 proof format is
three fixed-size group elements regardless of which R1CS the proving key encodes; the public
inputs (`oldCommitment`, `newCommitment`, `threshold`, `epochId`, `nullifier`, `txAmountHash`,
`merkleRoot`) are unchanged in count, order, and meaning. A chain observer watching
`shielded_transfer` calls learns exactly what they learn today — nothing about which hash function
computed the Merkle root, because that computation never leaves the proof. This experiment is
purely an internal constraint-system optimization; it does not touch the protocol's public
interface or its privacy properties (positive or negative).

**Assumptions carried over unchanged:** Groth16 soundness under BN254 discrete log (S2 in
`docs/threat-model.md`); the dev-only single-contributor trusted setup (RR2) — tonight's zkeys for
both `transfer.circom` and `transfer_poseidon2.circom` use the same kind of single-contributor
ceremony (see Approach, on why this was run *locally* rather than downloaded); domain-separated
Poseidon hashing for the other four instances (unchanged, still circomlib Poseidon).

**STRIDE mapping:** S2 (proof forgery — Groth16 soundness, unaffected), RR2 (trusted setup,
unaffected — new circuit, same ceremony style), RR5 (deposit-commitment linkability / anonymity
set — unaffected, same depth-20 tree). No entry in `docs/threat-model.md` needs to change, because
no security property changed — this is why the verdict below updates `BASELINE.md` with a new
section rather than touching `threat-model.md`.

## Approach

**What I built:**

1. `circuits/templates/merkle_proof_poseidon2.circom` — `MerkleProofPoseidon2(depth)`, structurally
   identical to the existing `MerkleProof(depth)` (same `MultiMux1`-based left/right swap on
   `pathIndices`, same boolean constraint on each index), but hashing each level with
   `Poseidon2(2)` in compression mode instead of circomlib's `Poseidon(2)`.
2. `circuits/transfer_poseidon2.circom` — a full research variant of `transfer.circom`: byte-for-byte
   identical for C1–C11 (commitments, nullifier, txAmountHash, range checks, threshold), only C0
   swapped to the new template. This isolates the swap as the *only* variable between the two
   circuits, so the constraint and timing diff is attributable to it alone. **Not wired into
   `pool.move`, the frontend, or any production path.**
3. Two isolated benchmark circuits, `circuits/bench-circuits/merkle20_{poseidon,poseidon2}.circom`
   — just the depth-20 Merkle check alone, nothing else, so the per-hasher constraint delta can be
   measured without `transfer.circom`'s other 8 constraints as noise.
4. `circuits/test/poseidon2.test.mjs` — three layers of correctness tests (25 random vectors against
   a JS reference permutation, the compression formula against an independent JS re-implementation
   of the same formula, and the full `MerkleProofPoseidon2` template including three negative
   tests: tampered sibling, non-boolean path index, wrong leaf — see Results).
5. `scripts/bench/constraint-report.mjs` — reusable `snarkjs r1cs info` diff table for any future
   circuit-variant comparison in this research loop.
6. `circuits/scripts/compile-poseidon2.sh` — mirrors `compile.sh`/`compile-withdraw.sh` for the
   research circuit; deliberately has no "copy to frontend" step.

**Library used:** `@taceo/circom-lib` (npm, published 2026-08-28) for the Poseidon2 circom
template and `@taceo/poseidon2` (same publisher) as the JS reference for correctness testing. Both
explicitly document "parity with the Rust `taceo-poseidon2` crate" and HorizenLabs-script-derived
BN254 parameters — the reference implementation the Poseidon2 paper itself points to.

**What I rejected:**

- **Hand-deriving Poseidon2 round constants myself**, rather than using a maintained package.
  Rolling a fresh implementation of a permutation's round constants and MDS/internal matrices by
  hand, for a security-critical primitive, with no independent way to verify the derivation, is
  exactly the kind of thing this loop's "no invented crypto parameters" spirit rules out. A
  maintained, narrowly-scoped library with an explicit parity claim to test against is safer than
  a from-scratch derivation I could not fully audit tonight.
- **Sponge mode at t=3** (mirroring the original `Poseidon(2)`'s width one-for-one, adding a
  Poseidon2 capacity element instead of using compression). This was the "safe, boring" option —
  smaller diff from the original construction — but it throws away exactly the win: at t=3, the
  external-round S-box count matches circomlib's Poseidon almost exactly (see Results, Layer
  isolation), so there would have been no meaningful constraint reduction to report. Compression
  mode at t=2 is what actually uses the "no wasted capacity slot" property Poseidon2 offers for
  2-to-1 hashing.
- **Swapping all four Poseidon instances at once** (commitments, nullifier, txAmountHash too).
  Those need t=4/t=5 arities. `@taceo/circom-lib` supports t=4 directly but not t=5, and a
  4-or-5-to-1 compression convention (as opposed to the well-established 2-to-1 case used by
  Merkle trees everywhere) needed more design work than one night could verify carefully. Scoping
  to the Merkle path alone kept this to one hypothesis with a citable construction, as the loop's
  own rules ask for.
- **Downloading a pre-generated Powers-of-Tau file**, as `compile.sh` normally does. Both mirror
  URLs the existing scripts know about (`storage.googleapis.com/zkevm/...` and
  `hermez.s3-eu-west-1.amazonaws.com/...`) returned `AccessDenied` tonight — a real, external
  change (bucket permissions), not a sandbox network block; both errors are genuine GCS/S3 XML
  `AccessDenied` bodies, not proxy 403s. Rather than block the whole experiment on that, I ran a
  local Powers-of-Tau ceremony (`snarkjs powersoftau new` → `contribute` → `prepare phase2`,
  single dev contributor) to produce `pot15_final.ptau` myself. This is not a new trust
  assumption: it's the same "dev-only, not for production" ceremony class `compile.sh` already
  uses for the downloaded file (which was itself a single Hermez/Polygon contribution, not a
  multi-party ceremony) — RR2 in `docs/threat-model.md` is unaffected either way.

## Results

### Layer isolation: the Merkle path alone (20× hasher, nothing else)

```
$ circom bench-circuits/merkle20_poseidon.circom --r1cs --wasm --sym --output bench-build -l node_modules
template instances: 73
non-linear constraints: 4920
linear constraints: 5480
public inputs: 41
private inputs: 0
public outputs: 1
wires: 10422
labels: 15544

$ npx snarkjs r1cs info bench-build/merkle20_poseidon.r1cs
[INFO]  snarkJS: Curve: bn-128
[INFO]  snarkJS: # of Wires: 10422
[INFO]  snarkJS: # of Constraints: 10400
[INFO]  snarkJS: # of Private Inputs: 0
[INFO]  snarkJS: # of Public Inputs: 41
[INFO]  snarkJS: # of Labels: 15544
[INFO]  snarkJS: # of Outputs: 1

$ circom bench-circuits/merkle20_poseidon2.circom --r1cs --wasm --sym --output bench-build -l node_modules
template instances: 11
non-linear constraints: 4380
linear constraints: 5360
public inputs: 41
private inputs: 0
public outputs: 1
wires: 9762
labels: 30424

$ npx snarkjs r1cs info bench-build/merkle20_poseidon2.r1cs
[INFO]  snarkJS: Curve: bn-128
[INFO]  snarkJS: # of Wires: 9762
[INFO]  snarkJS: # of Constraints: 9740
[INFO]  snarkJS: # of Private Inputs: 0
[INFO]  snarkJS: # of Public Inputs: 41
[INFO]  snarkJS: # of Labels: 30424
[INFO]  snarkJS: # of Outputs: 1
```

| Hasher (×20 calls) | Total constraints | Non-linear | Linear | Per-call non-linear |
|---|---|---|---|---|
| `Poseidon(2)` (circomlib, sponge, t=3) | 10,400 | 4,920 | 5,480 | 246 |
| `Poseidon2(2)` compression (t=2) | 9,740 | 4,380 | 5,360 | 219 |
| **Δ** | **-660 (-6.3%)** | **-540 (-11.0%)** | **-120 (-2.2%)** | **-27 (-11.0%)** |

The 27-constraint-per-call non-linear delta is fully explained by isolating the raw permutations
from the Merkle-specific wrapper (mux + feed-forward) around them:

```
$ circom /tmp/single_poseidon.circom --r1cs --output bench-build/single -l node_modules   # component main = Poseidon(2)
non-linear constraints: 243
linear constraints: 274

$ circom /tmp/single_poseidon2.circom --r1cs --output bench-build/single -l node_modules  # component main = Poseidon2(2)
non-linear constraints: 216
linear constraints: 267
```

Both permutations run the same 8 full rounds (4+4) with an identical 3-multiplication `x^5`
S-box; the only structural difference is state width. That decomposes the 243 → 216 delta (-27)
exactly:

- **Full rounds:** t=3 applies the S-box to 3 state elements per full round, t=2 to 2 —
  `8 rounds × 1 fewer element × 3 constraints/S-box = 24` fewer non-linear constraints.
- **Partial rounds:** circomlib's Poseidon uses 57 partial rounds at t=3
  (`N_ROUNDS_P[t-2]` in `poseidon.circom`); this Poseidon2 parameter set uses 56 at t=2 — one
  fewer partial round × 3 constraints/S-box = **3** fewer.
- 24 + 3 = 27, matching the measured delta exactly.

The remaining +3 non-linear constraints per level in both circuits (243→246, 216→219) come from
`MultiMux1(2)`'s left/right selector, identical in both templates, which is why it doesn't show up
in the delta at all. **The honest reading: this is a structural saving from not paying for an
unused capacity element (compression mode, t=2) rather than sponge mode (t=3) — it is not evidence
that Poseidon2's round function is intrinsically cheaper than Poseidon's per element at equal
width.** A sponge-mode Poseidon2 at t=3 would have cost the same 243 non-linear constraints
Poseidon already does (mod the ±1 partial-round rounding some parameter sets apply), which is
exactly why that option was rejected in Approach. Queue item 2's original framing ("Poseidon2 vs
current Poseidon") undersold this nuance — the win is about avoiding sponge mode for 2-to-1
hashing, not about Poseidon2 being a faster permutation in the abstract. Re-ranking in
`EXPERIMENTS.md` reflects this.

### Full circuit: `transfer.circom` vs `transfer_poseidon2.circom`

```
$ node scripts/bench/constraint-report.mjs \
    "transfer (Poseidon)":circuits/build/transfer.r1cs \
    "transfer_poseidon2":circuits/build-poseidon2/transfer_poseidon2.r1cs
```

| Circuit | Total constraints | Non-linear | Linear | Wires |
|---|---|---|---|---|
| `transfer.circom` (current, `docs/research/BASELINE.md`) | 13,611 | 6,470 | 7,141 | 13,632 |
| `transfer_poseidon2.circom` (C0 swapped only) | 12,951 | 5,930 | 7,021 | 12,972 |
| **Δ** | **-660 (-4.85%)** | **-540 (-8.34%)** | **-120 (-1.68%)** | **-660** |

This matches the isolated Merkle-path delta exactly (-660 total / -540 non-linear), confirming C0
was the only thing that changed and nothing else regressed or improved incidentally.

### Correctness — `node --experimental-vm-modules test/poseidon2.test.mjs`

```
=== Veil Poseidon2 Merkle-path — correctness & soundness tests ===

--- Layer 1: Poseidon2(t=2) permutation vs JS reference ---
  [PASS] P1: permutation([0,0]) matches reference
  [PASS] P2: permutation([1,2]) matches reference
  [PASS] P3: 25 random inputs all match reference
  [PASS] P4: permutation is not the identity (sanity — catches a no-op template)

--- Layer 2: 2-to-1 compression (out = perm(in)[0] + left) ---
  [PASS] C1: compress2(0,0) matches reference formula
  [PASS] C2: 25 random (left,right) pairs match reference formula
  [PASS] C3: compress2(a,b) != compress2(b,a) for a != b (feed-forward breaks symmetry)

--- Layer 3: MerkleProofPoseidon2(20) — root computation + negative tests ---
  [PASS] M1: valid path computes the expected root
  [PASS] M2 (negative): tampered sibling produces a different root, not a matching one
  [PASS] M3 (negative): non-boolean pathIndices is rejected at witness generation
  [PASS] M4 (negative): a witness for the wrong leaf does not match the honest root

=== Results: 11 passed, 0 failed ===
```

M2–M4 are the negative tests this loop's rules require for any circuit change: a forged sibling
(M2), a malformed index that isn't 0 or 1 (M3, mirrors `transfer.test.mjs` T43 against the
original template), and a substituted leaf (M4) are all rejected — none of them can be made to
reproduce the honest root, which is exactly the soundness property C0 needs.

### Proving time — `node scripts/bench/prove-latency.mjs --runs 10`

```
=== Veil Groth16 proving-time benchmark (10 runs per circuit) ===
node v22.22.2, linux/x64

--- transfer ---
  runs: 10
  mean: 740.05 ms   stddev: 27.44 ms   min: 708.29 ms   max: 793.35 ms
  proof JSON size: 723 bytes, public signals: 7

--- withdraw ---
  runs: 10
  mean: 226.70 ms   stddev: 18.80 ms   min: 200.25 ms   max: 267.35 ms
  proof JSON size: 724 bytes, public signals: 5

--- compliance ---
  runs: 10
  mean: 692.33 ms   stddev: 34.42 ms   min: 631.01 ms   max: 746.00 ms
  proof JSON size: 721 bytes, public signals: 6

--- transfer_poseidon2 ---
  runs: 10
  mean: 670.88 ms   stddev: 28.06 ms   min: 634.99 ms   max: 714.97 ms
  proof JSON size: 721 bytes, public signals: 7
```

| Circuit | Mean proving time (10 runs) | Δ vs `transfer` |
|---|---|---|
| `transfer.circom` | 740.05 ms (σ 27.44) | — |
| `transfer_poseidon2.circom` | 670.88 ms (σ 28.06) | **-69.17 ms (-9.35%)** |

A real, measured wall-clock improvement, directionally consistent with (and slightly larger than)
the -8.34% non-linear-constraint reduction — plausible since non-linear constraints drive the
multi-scalar-multiplication cost in Groth16 proving more directly than linear ones, and the two
per-run stddevs (27–28 ms) mean this delta sits a little over 2σ, not a slam-dunk statistically but
consistent in direction and magnitude with the constraint-count delta measured independently above.
`transfer`/`withdraw`/`compliance` numbers here are also a fresh, independent re-measurement of
`BASELINE.md`'s existing figures (751.9 / 244.3 / 738.1 ms there) on the same kind of hardware
class tonight (740.1 / 226.7 / 692.3 ms) — close enough (within the run-to-run noise both nights
show) to trust this benchmark run's methodology.

One environment note for whoever reproduces this: the Groth16 **trusted-setup** step
(`snarkjs groth16 setup`, one-time per circuit) took roughly 20 minutes for the two ~13k-constraint
circuits on this machine tonight — 15–30x slower than what the per-proof numbers above would
suggest is normal for this hardware class. Proving itself (the benchmarked operation) was not
affected; only the one-time setup phase was unusually slow, for reasons not investigated further
(not on tonight's hypothesis — noted here only so a future run isn't surprised by it).

### Test suite

Run in full where the toolchain allowed it (same scope as the 2026-07-22 baseline run):

| Suite | Result | Command |
|---|---|---|
| Circuits (real Groth16 proofs) | **108/108 pass** (43 transfer + 30 compliance + 35 withdraw) | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` (run individually — known `&&`-chain hang, queue item 14) |
| Poseidon2 correctness + negative tests | **11/11 pass** | `node --experimental-vm-modules test/poseidon2.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils (credential leaf, Merkle builder) | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Property-based fuzz (fast-check) | **6/6 properties pass** (500 cases each) | `cd scripts && bun run src/fuzz-tests.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Move contracts | **NOT RUN** | `sui` CLI unavailable — same blocker as 2026-07-22 (see Approach: on-chain gas re-attempt) |

`transfer.circom`'s own 43/43, `compliance.circom`'s 30/30, and `withdraw.circom`'s 35/35 exactly
reproduce the 2026-07-22 baseline's counts — nothing about the *existing* circuits regressed by
building `transfer_poseidon2.circom` alongside them. No test was loosened, skipped, or given new
tolerance to reach any of these numbers.

## Verdict: **KEEP**

A real, measured, fully-verified win: -540 non-linear constraints (-8.34%), -660 total (-4.85%)
on `transfer.circom`'s constraint count, and a corresponding -69.17ms (-9.35%) Node proving-time
reduction, from a swap whose correctness rests on an established construction (zk-kit's
Poseidon2-compression Merkle hashing) rather than an invented one, verified against a JS reference
across 25+ random vectors plus 3 negative tests. Nothing in the existing test suite regressed.

What "KEEP" means concretely here, since this is a circuit change that was deliberately **not**
wired into production: `transfer_poseidon2.circom`, its template, its tests, and the benchmark
scripts all merge into the branch as real, reusable artifacts — `docs/research/BASELINE.md` gets a
new section documenting this as an available, verified alternative circuit with real numbers
attached, not a design note. What does NOT happen tonight: `pool.move`'s `transfer_vk` is not
updated, the deployed testnet pool is not migrated, and the frontend does not gain a second proving
path. Those are a real integration task (a VK migration, ideally behind a proper multi-party
ceremony rather than tonight's local single-contributor one), correctly scoped to its own future
night — re-ranked to the top of `EXPERIMENTS.md` (item 2) now that the measurement and correctness
work that would have blocked it is already done.

The one thing to flag honestly for whoever picks up that integration: this experiment's own
correctness check has a residual gap (no independent second Poseidon2 parameter-set cross-check —
see Open questions #3) that's cheap to close and worth closing *before* a production VK migration,
even though it wasn't a blocker for merging the research artifact itself tonight.

## Where this could be used

- **Any Circom/Groth16 protocol using a Poseidon-hashed Merkle accumulator** for anonymity sets or
  UTXO commitments (Tornado-Cash-style mixers, Semaphore-style membership proofs, other
  shielded-pool designs) — the 2-to-1 compression swap generalizes directly; depth-20 here, but
  the per-level saving scales linearly with depth, so a deeper tree (item 6 in `EXPERIMENTS.md`,
  10^5–10^7 commitments) would see the same ~11% per-level non-linear reduction compounded over
  more levels.
- **zk-kit / Semaphore-adjacent identity and credential systems** already moving to Poseidon2
  compression for their own Merkle roots (the vendored `binary_merkle_root.circom` in
  `@taceo/circom-lib` literally credits `zk-kit/zk-kit.circom` as its source) — this experiment is
  independent confirmation, on Veil's own constraint set, of the same design choice they made.
- **A thesis chapter on ZK-circuit micro-optimization** needing a controlled, isolated example of
  "same permutation, same round count, different state width" — the layer-isolation table above
  (10,400 → 9,740 constraints, attributable purely to the capacity slot) is a clean pedagogical
  case that a lot of "Poseidon2 is faster" claims skip past.

## Open questions (next queue)

1. **Wire this into production** — update `pool.move`'s `transfer_vk`, regenerate the verifying
   key from `transfer_poseidon2.circom`'s (real, multi-party) trusted setup, migrate the deployed
   testnet pool. A real integration task, not a parameter change; natural next step now that the
   circuit and its tests exist.
2. **The other three named Poseidon instances** (commitments, nullifier, txAmountHash — t=4/t=5)
   — `@taceo/circom-lib` supports t=4 directly; t=5 is unsupported by that library's `assert(t==2
   || t==3 || t==4 || t==8 || t==12 || t==16)` and would need either padding to t=8 (wasteful) or
   a different Poseidon2 arity choice.
3. **Independent second Poseidon2 implementation cross-check.** Tonight's correctness check
   compares `@taceo/circom-lib`'s circom template against `@taceo/poseidon2`'s JS permutation —
   same publisher, same claimed parameter provenance. A from-scratch derivation from the
   HorizenLabs sage script (or a comparison against a completely independent implementation using
   the *same* parameter set, not just "also called Poseidon2" — several projects use
   different round-constant derivations under that name) would close the one residual correctness
   assumption this experiment carries.
4. **Merkle depth vs. anonymity-set size** (queue item 6) can now reuse this exact per-level
   constraint cost when it models the depth/anonymity-set/proving-time trade-off — the marginal
   cost of one more tree level is now a measured 219 non-linear constraints under Poseidon2 vs.
   246 under Poseidon, not an estimate.
