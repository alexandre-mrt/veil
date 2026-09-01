# 2026-09-01 — Poseidon2 vs Poseidon: constraint-count and proving-time delta (queue item #2)

## Hypothesis

Swapping the four Poseidon instances in `transfer.circom` and `compliance.circom`
(and the four in `withdraw.circom`) for Poseidon2 reduces non-linear R1CS
constraint count and Node.js Groth16 proving time for all three circuits,
using the only currently-installable circom Poseidon2 implementation
(`@taceo/circom-lib@0.9.0`, npm). This experiment moves that from a guess to a
measured number — either confirming the hypothesized win, or falsifying it
with a real, explained cause.

Falsified. The naive swap **increases** Node proving time for `transfer.circom`
(+31.8%) and `withdraw.circom` (+27.0%), and only marginally improves
`compliance.circom` (-8.5%) — the opposite of "moves prover time down for
every circuit." The cause is identified precisely (see Results): the only
available library supports permutation widths `t ∈ {2,3,4,8,12,16}`, and
three of Veil's four real Poseidon arities need `t ∈ {5,6}`, forcing a
zero-pad up to `t=8` that pushes `transfer` and `withdraw` over a Groth16 FFT
domain-size doubling (`2^n → 2^(n+1)`) — a real, mechanistic, non-obvious
cost this experiment surfaces with numbers, not guessed.

## Threat / privacy model

**Adversary model — no change from the deployed protocol.** Nothing in this
experiment is wired into `circuits/transfer.circom`, `compliance.circom`,
`withdraw.circom`, the Move contracts, any deployed verification key, or the
frontend. Every file this experiment touches lives under
`circuits/poseidon2-experiment/` and `scripts/bench/poseidon2-*`, is clearly
labeled EXPERIMENTAL in-file, and nothing under it is imported by production
code. A chain observer, colluding relayer, malicious auditor, or malicious
prover sees and can do exactly what `docs/threat-model.md` already documents
— this experiment changes none of it. STRIDE mapping: none of the existing
`docs/threat-model.md` entries change; this is a pure R&D benchmark.

**What a real (hypothetical) production swap would need to defend against,**
since the writeup's Verdict recommends a narrower follow-up experiment next
time:

- **Malicious prover (S2 in `docs/threat-model.md`).** The swapped gadget
  must still make `out` a function that's actually *bound* to the
  permutation of the real inputs, not an unconstrained free signal a
  malicious witness could set arbitrarily. Verified empirically below (see
  Approach/Results — negative test).
- **Multi-arity collision in the padding scheme.** `Poseidon2Hash(nInputs)`
  zero-pads `state[nInputs+1 .. actualT-1]` with no arity/length encoding.
  This is safe *only* because every call site in Veil's circuits uses a
  fixed, compile-time-constant `nInputs` — there is no code path where an
  attacker chooses `nInputs` at runtime, so `Poseidon2Hash(4)`'s padded state
  `[0,a,b,c,d,0,0,0]` can never collide with an attacker-controlled
  `Poseidon2Hash(7)` call, because no such call exists in these circuits. A
  hypothetical *general-purpose* variable-arity version of this gadget would
  need a domain-separated padding scheme (e.g. encoding `nInputs` in an
  unused capacity/padding slot) before this residual ambiguity could be
  called safe outside this specific fixed-arity usage. Flagged, not fixed,
  since nothing here is production code.
- **Trusted setup / parameter provenance.** `@taceo/circom-lib`'s round
  constants are used as published, on the library's claim of "parity with
  the Rust `taceo-poseidon2` crate" and compatibility with the HorizenLabs
  parameter script. This experiment did not independently re-derive or audit
  those constants — a real production adoption would need to (same class of
  assumption as RR2's ceremony trust, just for a different artifact).

## Approach

**What I built** (all under `circuits/poseidon2-experiment/` and
`scripts/bench/poseidon2-*`, all reused/reproducible via committed scripts):

1. Built `circom` 2.2.2 from source (`iden3/circom` tag `v2.2.2`,
   `cargo build --release`, ~60s) — same toolchain gap and same fix as the
   2026-07-22 baseline; not re-documented as a new blocker.
2. `circuits/poseidon2-experiment/poseidon2_hash.circom` — a
   `Poseidon2Hash(nInputs)` template with the same call interface as
   circomlib's `Poseidon(nInputs)`, built on `@taceo/circom-lib@0.9.0`'s
   `Poseidon2(t)` permutation (npm, MIT-licensed, vendored as a real
   `node_modules` dependency via a scoped `package.json`, not copy-pasted).
   Sponge convention: `state[0]=0` (capacity), `state[1..nInputs]=inputs`,
   squeeze `state[0]`. Zero-pads to the next of `{2,3,4,8,12,16}` when
   `nInputs+1` isn't already one of them.
3. `circuits/poseidon2-experiment/templates/merkle_proof_p2.circom` — the
   existing `MerkleProof(depth)` template with its `Poseidon(2)` hasher
   swapped for `Poseidon2Hash(2)`.
4. `circuits/poseidon2-experiment/{transfer,compliance,withdraw}_p2.circom`
   — full, compilable copies of the three production circuits with every
   `Poseidon(n)` → `Poseidon2Hash(n)` and `MerkleProof` → `MerkleProofP2`,
   generated mechanically (see the file headers) so the swap is exhaustive
   and not hand-picked.
5. `circuits/poseidon2-experiment/compile-p2.sh` — circom compile + dev-only
   Groth16 setup for all three variants (mirrors `../scripts/compile*.sh`).
6. `circuits/poseidon2-experiment/negative-test.mjs` — real Groth16
   proof/verify of a valid witness, plus two tampered-witness rejection
   checks (see Results).
7. `scripts/bench/poseidon2-hash.mjs` — the JS-side companion hash
   (`@taceo/poseidon2@0.2.0`, the same team's published JS permutation,
   "parity with the Rust crate" per its own README) so witness generation for
   the swapped circuits uses the *same* construction as the circuit, not an
   approximation.
8. `scripts/bench/poseidon2-prove-latency.mjs` — reuses
   `scripts/bench/witnesses.mjs` unmodified (its `poseidon(inputs)` interface
   didn't need to change), same warm-up + N-runs methodology as
   `prove-latency.mjs`.
9. A separate, isolated micro-benchmark (raw `circom --r1cs` compiles of
   bare `Poseidon(n)` for `n∈{2,3,4,5}` and bare `Poseidon2(t)` for
   `t∈{2,3,4,8}`) to get clean per-instance constraint costs, independent of
   any full-circuit context. Not committed to the repo (pure scratch
   micro-benchmark, superseded by the full-circuit numbers below, which are
   the ones that matter) — the underlying real, run numbers are pasted in
   Results.

**What I rejected before building this:**

- **Building `sui` from source to unblock queue item #1 first**, per this
  run's instructions — quick `cargo install`-from-crates.io check only
  (crates.io's `sui` and `sui-sdk` are unrelated name-squatted placeholder
  crates, 0 deps, versions `0.0.1`/`0.0.0` — not the Mysten Labs CLI; no
  `sui-cli`/`mysten-sui`/`sui_cli` crate exists either). Confirmed dead in
  under 5 minutes, moved on rather than attempting a from-source monorepo
  build. Re-marking item #1 BLOCKED a third time below.
- **Writing custom Poseidon2 round constants for `t=5`/`t=6`** (Veil's
  actual missing arities) via the HorizenLabs sage parameter script, to
  avoid the padding tax entirely. This is real, scoped, plausible future
  work — but generating and independently verifying fresh cryptographic
  round constants in the same night as everything else above was judged too
  much to also do carefully. Parked as the natural next step (see Open
  questions), not attempted.
- **Wiring the swap into production `transfer.circom` etc. directly**,
  editing in place. Rejected because (a) the arity gap above means a direct
  edit would silently degrade proving time without anyone measuring it
  first — exactly the outcome this experiment exists to prevent — and (b) it
  would require simultaneously updating every JS/TS witness-generation call
  site (`frontend/`, `scripts/`, `circuits/test/`) to the new hash, which is
  a coordinated migration, not a parameter tweak, best done deliberately if
  the numbers ever justify it.

## Results

### Full-circuit comparison (real compiles, real Groth16 setup + proving, same machine/session)

Toolchain: circom 2.2.2 (built from source, `iden3/circom` tag `v2.2.2`,
same as 2026-07-22), snarkjs 0.7.6, Node v22.22.2, pot15 Powers of Tau
(same file/URL as the production `compile*.sh` scripts), single dev-only
Groth16 contribution (non-production, matches existing practice).

| Circuit | Non-linear (base → P2) | Total R1CS (base → P2) | Groth16 FFT domain (base → P2) | Node proving time, mean of 10 (base → P2) |
|---|---|---|---|---|
| `transfer` | 6,470 → 6,599 (+2.0%) | 13,611 → 17,899 (**+31.5%**) | 16,384 → **32,768** (2×) | 715.75ms → 943.03ms (**+31.8%**) |
| `compliance` | 6,057 → 6,036 (**-0.3%**) | 12,743 → 15,325 (+20.3%) | 16,384 → 16,384 (unchanged) | 712.75ms → 651.97ms (**-8.5%**) |
| `withdraw` | 1,465 → 1,651 (+12.7%) | 3,058 → 5,902 (**+93.0%**) | 4,096 → **8,192** (2×) | 238.47ms → 302.80ms (**+27.0%**) |

The "base" proving-time column is a fresh same-session re-run of
`scripts/bench/prove-latency.mjs --runs 10` (not the 40-day-old
2026-07-22 numbers) so the comparison is apples-to-apples on one machine in
one sitting; it independently reproduces the 2026-07-22 baseline's
constraint counts exactly and its proving times within normal run-to-run
noise (both cited below).

**Why `compliance` improves while `transfer`/`withdraw` regress despite all
three having a similar arity mix:** Groth16 proving time in snarkjs is driven
largely by the FFT over a domain sized to the next power of two ≥ total R1CS
constraints, plus an MSM sized to the non-linear constraint count.
`compliance`'s total constraints (12,743 → 15,325) stay under the 16,384
ceiling in both cases — no FFT domain change — so its small non-linear
*decrease* (-21, from a lucky padding fit) is pure proving-time win.
`transfer` (13,611 → 17,899) and `withdraw` (3,058 → 5,902) both cross a
power-of-two boundary, roughly doubling FFT cost, which swamps their small
non-linear-side changes.

### Raw command output

```
$ /tmp/…/circom/target/release/circom transfer_p2.circom --r1cs --wasm --sym -o build -l .
non-linear constraints: 6599
linear constraints: 11300
wires: 17920
Written successfully: build/transfer_p2.r1cs

$ /tmp/…/circom/target/release/circom compliance_p2.circom --r1cs --wasm --sym -o build -l .
non-linear constraints: 6036
linear constraints: 9289
wires: 15344
Written successfully: build/compliance_p2.r1cs

$ /tmp/…/circom/target/release/circom withdraw_p2.circom --r1cs --wasm --sym -o build -l .
non-linear constraints: 1651
linear constraints: 4251
wires: 5902
Written successfully: build/withdraw_p2.r1cs
```

Cross-checked with `snarkjs r1cs info` (matches circom's own count exactly,
same as the baseline night):

```
$ npx snarkjs r1cs info build/transfer_p2.r1cs
[INFO]  snarkJS: # of Wires: 17920
[INFO]  snarkJS: # of Constraints: 17899
$ npx snarkjs r1cs info build/compliance_p2.r1cs
[INFO]  snarkJS: # of Wires: 15344
[INFO]  snarkJS: # of Constraints: 15325
$ npx snarkjs r1cs info build/withdraw_p2.r1cs
[INFO]  snarkJS: # of Wires: 5902
[INFO]  snarkJS: # of Constraints: 5902
```

Fresh same-session original-circuit compile (reproduces 2026-07-22 exactly):

```
$ circom transfer.circom --r1cs --wasm --sym -o build -l node_modules
non-linear constraints: 6470   linear constraints: 7141   wires: 13632
$ circom withdraw.circom --r1cs --wasm --sym -o build-withdraw -l node_modules
non-linear constraints: 1465   linear constraints: 1593   wires: 3058
$ circom compliance.circom --r1cs --wasm --sym -o build-compliance -l node_modules
non-linear constraints: 6057   linear constraints: 6686   wires: 12762
```

Node proving time (`node scripts/bench/prove-latency.mjs --runs 10`, same session):

```
=== Veil Groth16 proving-time benchmark (10 runs per circuit) ===
node v22.22.2, linux/x64

--- transfer ---
  mean: 715.75 ms   stddev: 26.30 ms   min: 665.52 ms   max: 768.33 ms
--- withdraw ---
  mean: 238.47 ms   stddev: 12.41 ms   min: 215.49 ms   max: 255.44 ms
--- compliance ---
  mean: 712.75 ms   stddev: 28.23 ms   min: 665.09 ms   max: 757.87 ms
```

Node proving time, Poseidon2 experimental variants
(`node scripts/bench/poseidon2-prove-latency.mjs --runs 10`):

```
=== Veil Poseidon2-experiment Groth16 proving-time benchmark (10 runs per circuit) ===
node v22.22.2, linux/x64

--- transfer (poseidon2 experimental) ---
  mean: 943.03 ms   stddev: 30.07 ms   min: 902.39 ms   max: 999.14 ms
--- withdraw (poseidon2 experimental) ---
  mean: 302.80 ms   stddev: 7.24 ms   min: 291.89 ms   max: 313.86 ms
--- compliance (poseidon2 experimental) ---
  mean: 651.97 ms   stddev: 18.46 ms   min: 629.83 ms   max: 685.77 ms
```

### Per-instance isolation (answers 2026-07-22's open question #4)

Standalone compiles of bare `Poseidon(n)` (circomlib) and bare `Poseidon2(t)`
(`@taceo/circom-lib`, raw permutation — a hash built on it costs the same
non-linear total, wrapping adds only free/linear wiring):

```
$ circom orig_2.circom --r1cs --sym -o build    # Poseidon(2), used for the Merkle path + withdraw recipientHash
non-linear constraints: 243   linear constraints: 274
$ circom orig_3.circom --r1cs --sym -o build    # Poseidon(3)
non-linear constraints: 264   linear constraints: 341
$ circom orig_4.circom --r1cs --sym -o build    # Poseidon(4), the dominant arity in transfer/withdraw
non-linear constraints: 300   linear constraints: 436
$ circom orig_5.circom --r1cs --sym -o build    # Poseidon(5), compliance's credential leaf
non-linear constraints: 324   linear constraints: 511

$ circom p2_2.circom --r1cs --sym -o build      # Poseidon2(t=3) permutation — natively supported
non-linear constraints: 216   linear constraints: 267
$ circom p2_3.circom --r1cs --sym -o build      # Poseidon2(t=4) — natively supported
non-linear constraints: 240   linear constraints: 340
$ circom p2_4.circom --r1cs --sym -o build      # Poseidon2(t=5)... not supported, this is raw t=4
non-linear constraints: 264   linear constraints: 588
$ circom p2_8.circom --r1cs --sym -o build      # Poseidon2(t=8) — what t=5,6,7 pad up to
non-linear constraints: 363   linear constraints: 1300
```

Per-arity delta (`Poseidon(nInputs)` uses state `t=nInputs+1` internally, so
compare against `Poseidon2` at that same `t`):

| `nInputs` (used at) | `t` | Native P2 width? | Poseidon nl | Poseidon2 nl | Δ nl |
|---|---|---|---|---|---|
| 2 (Merkle path ×20/proof, withdraw `recipientHash`) | 3 | **yes** | 243 | 240 | **-3 (-1.2%)** |
| 3 (`txAmountHash`, compliance `nfHash`/`ctxHash`) | 4 | **yes** | 264 | 264 | 0 (0%) |
| 4 (transfer `oldHash`/`newHash`/`nfHash`, withdraw `commHash`/`changeHash`/`nfHash`) | 5 | no → pad to 8 | 300 | 363 | **+63 (+21.0%)** |
| 5 (compliance credential `leafHash`) | 6 | no → pad to 8 | 324 | 363 | **+39 (+12.0%)** |

Poseidon2 is a real (small) win exactly where its native widths line up with
Veil's usage (`t=3`, the depth-20 Merkle path — the single highest-volume
call site, 20 hashes per proof) and tied where they also line up (`t=4`) —
but a real loss everywhere Veil needs `t=5` or `t=6`, which is most of
`transfer`'s and `withdraw`'s non-Merkle constraint budget.

Attributing each production circuit's non-linear constraints to its Poseidon
instances (using the per-instance numbers above against the real, unmodified
circuit totals — this is the number 2026-07-22's report asked for):

| Circuit | Total non-linear | Poseidon-instance-attributable | Everything else (range checks, comparators, Merkle-path muxes) |
|---|---|---|---|
| `transfer` | 6,470 | 6,024 (20×243 + 3×300 + 264) — **93.1%** | 446 — 6.9% |
| `compliance` | 6,057 | 5,712 (20×243 + 324 + 2×264) — **94.3%** | 345 — 5.7% |
| `withdraw` | 1,465 | 1,143 (3×300 + 243) — **78.0%** | 322 — 22.0% |

Poseidon dominates all three circuits' non-linear cost, and for the two
circuits with a Merkle proof, the depth-20 path alone (`20×243=4,860`) is
**75.1%** of `transfer`'s and **80.2%** of `compliance`'s total non-linear
constraints on its own — a bigger lever than every other Poseidon call in
either circuit combined.

### Negative test (soundness check on the experimental gadget)

`node circuits/poseidon2-experiment/negative-test.mjs`:

```
[PASS] valid witness proves and verifies: true
[PASS] tampered nullifier (!= Poseidon2Hash(2, userSecret, epochId, randomnessOld)): rejected — Error: Assert Failed. Error in template Transfer_35 line: 128
[PASS] tampered oldCommitment (!= Poseidon2Hash(4, 1, cumulativeOld, randomnessOld, userSecret)): rejected — Error: Assert Failed. Error in template Transfer_35 line: 69

All checks passed.
```

Confirms `Poseidon2Hash`'s `out` is a real constraint, not an unconstrained
free signal — a malicious witness claiming a wrong public commitment/nullifier
is rejected at witness-generation time, same failure mode the production
circuits already rely on for `oldCommitment === oldHash.out` etc.

### Test suite (full run, this session)

| Suite | Result | Command |
|---|---|---|
| Circuits (real Groth16 proofs, unmodified production circuits) | **108/108 pass** (43 transfer + 35 withdraw + 30 compliance) | `node --experimental-vm-modules test/{transfer,withdraw,compliance}.test.mjs` (run individually — chained `npm test` hang, item 12, already fixed for the test files themselves by #17; the new bench scripts hit the same underlying `snarkjs` lingering-handle issue, see Open questions) |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bun run test` |
| Move contracts | **NOT RUN** — same blocker as 2026-07-22 and every session since | `sui` CLI unavailable (see queue item #1 below) |
| Poseidon2-experiment negative test | **3/3 pass** | `node circuits/poseidon2-experiment/negative-test.mjs` |

No test was loosened, skipped, or given new tolerance. Nothing in
`circuits/transfer.circom`, `compliance.circom`, `withdraw.circom`, any Move
module, or the frontend was modified by this experiment.

## Verdict: **REJECT** (naive swap; a narrower follow-up is parked, not this)

The hypothesis as stated — swap all Poseidon instances for Poseidon2, get a
uniform constraint/proving-time win — is **false** for the only currently
installable circom Poseidon2 library. Measured, real proving time got
**worse** for `transfer` (+31.8%) and `withdraw` (+27.0%), the two circuits
run on every ordinary transfer and every exit; `compliance` (the
KYC-threshold path, lower volume) improved by a modest 8.5%. Net effect
across the protocol: a regression, not an improvement. Rejecting the naive
full swap as measured — the branch and every number above survive for the
next attempt.

The root cause is not "Poseidon2 is slower" in general — the per-instance
table shows it's a small real win or a tie at the two widths (`t=3`, `t=4`)
this library natively supports. The cause is a specific, fixable mismatch:
`@taceo/circom-lib`'s supported widths (`{2,3,4,8,12,16}`) don't cover two of
Veil's four real arities (`t=5,6`), and padding up to `t=8` is expensive
enough (non-linear constraints alone: `+21%` and `+12%` per instance) to push
two of the three circuits over a Groth16 FFT domain-size doubling. That's a
concrete, scoped blocker for a follow-up experiment (see Open questions), not
a dead end for Poseidon2 as an idea.

`BASELINE.md` gets one addition despite the REJECT verdict: the per-instance
constraint breakdown above is a real, currently-true fact about the
*unmodified, deployed* circuits (it doesn't change any existing headline
number, just decomposes it), and directly answers 2026-07-22's open question
#4 — added as a new subsection rather than replacing anything.

## Where this could be used

- **Any Circom/Groth16 UTXO-style protocol with a Merkle-accumulator
  membership proof** should treat the Merkle-path hash arity as the single
  highest-leverage optimization target before touching anything else — here
  it's 75-80% of two circuits' non-linear cost on its own, and happens to sit
  exactly on Poseidon2's best-supported width (`t=3`). A protocol integrator
  copying Veil's `MerkleProof(depth)` template gets that lever for free.
- **A thesis chapter or benchmark suite comparing Poseidon vs Poseidon2
  in-circuit** gets a concrete, sourced counter-example to the common
  "Poseidon2 is strictly faster" claim: that claim holds for native
  (non-circuit) hashing throughput and hardware efficiency, not uniformly for
  R1CS constraint count with a library whose supported widths don't match
  your protocol's arities. Worth citing as a methodology point: measure your
  own arities, don't extrapolate from the paper's headline numbers.
- **Any fixed-schema commitment protocol** (confidential payroll, a
  compliance-gated pool, anything with a small number of compile-time-fixed
  hash arities) considering a hash-function migration should budget for
  generating arity-matched round constants (not just picking the nearest
  supported width) as part of the migration cost, not an afterthought —
  exactly the gap this experiment found.

## Open questions (next queue)

1. **Arity-aware partial swap**: swap only the depth-20 `MerkleProof` hasher
   (`Poseidon(2)`→`Poseidon2Hash(2)`, natively supported, measured `-3`
   non-linear constraints/instance, ×20/proof = -60 non-linear per Merkle
   proof in both `transfer` and `compliance`) and leave `oldHash`/`newHash`/
   `nfHash`/`leafHash`/etc. as plain Poseidon. This avoids the `t=5,6`
   padding tax entirely and, since it's a pure decrease, shouldn't cross any
   FFT domain-size boundary — plausibly a real, uncomplicated win. Highest
   priority next step for this specific idea.
2. **Custom Poseidon2 round constants for `t=5` and `t=6`** (Veil's actual
   missing arities) via the HorizenLabs sage parameter generator referenced
   in `@taceo/circom-lib`'s README, to make the full swap viable without the
   padding tax. Bigger lift — generating and verifying fresh round constants
   is real cryptographic engineering, not a config change — budget a
   dedicated night.
3. **On-chain gas per entry point** — still `BASELINE.md`'s one fully
   BLOCKED axis, now blocked a third time for a third reason (see
   `LEDGER.md`). Re-ranked below.
4. `scripts/bench/prove-latency.mjs` and `browser-latency.mjs` still hang
   after printing (the same lingering-`snarkjs`-worker-handle issue
   documented in the 2026-07-22 report and fixed for `circuits/test/*.mjs`
   by #17) — confirmed again tonight (had to `kill -9` a stuck
   `prove-latency.mjs` run). `poseidon2-prove-latency.mjs` added the same
   `process.exit(0)` fix from the start; the other two bench scripts should
   get it too. Small, low-priority, real papercut.
5. Mobile WASM proving latency — unchanged from 2026-07-22's open question
   #3, still a good "spend an hour" candidate.
