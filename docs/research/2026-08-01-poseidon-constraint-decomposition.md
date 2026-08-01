# 2026-08-01 — Poseidon vs. range-check constraint decomposition (queue item #2)

## Hypothesis

Every non-linear R1CS constraint in `transfer.circom`, `compliance.circom`, and `withdraw.circom` can
be attributed to a specific, named gadget instantiation (a Poseidon call of a given arity, a
`Num2Bits`/comparator of a given width, or a handful of top-level circuit statements) with zero
unexplained residual — replacing the 2026-07-22 baseline report's open question ("what fraction of
non-linear constraints come from the four Poseidon instances vs. the `Num2Bits(64)` range checks?")
with an exact, reproducible number instead of a guess. The number this experiment moves: the fraction
of each circuit's non-linear constraint budget spent on Poseidon hashing, measured, not estimated.

This is queue item #2 from `EXPERIMENTS.md`, taken via its second framing ("re-derive the exact
non-linear-constraint contribution per Poseidon instance from the current baseline") rather than the
first (swap in Poseidon2) — see Approach for why.

## Threat / privacy model

No production circuit, Move module, or frontend proving path was modified. Nothing about the
deployed protocol's soundness or privacy changes, so there is no new adversary this experiment
defends against or exposes the system to. The relevant framing, as in the 2026-07-22 baseline report,
is narrower: **who relies on this number being honest.**

- **A future Poseidon2 (or any hash-swap) experiment** needs to know which of the four *named*
  Poseidon domain-tag calls (`Poseidon(4)`×3, `Poseidon(3)`×1 in `transfer.circom`, for instance)
  actually dominate cost, versus the Poseidon calls hidden inside `MerkleProof(20)` that the existing
  source comments don't count at all (see Results — this turns out to matter a lot). Get this wrong
  and a future night could "optimize" the four visible instances while leaving 75%+ of the actual
  Poseidon cost untouched inside the Merkle template.
- **A protocol integrator or thesis reader** citing "Poseidon dominates the constraint budget" should
  be able to reproduce the exact per-gadget breakdown from a checked-in script, not take the claim on
  faith.

What this does **not** establish: whether isolating a gadget changes its cost when composed with
others (it doesn't, empirically — see Results, the reconstruction matches exactly), whether Poseidon2
would actually reduce these numbers (that's the next experiment, not this one), or anything about
on-chain gas (still blocked — see below). It touches no `docs/threat-model.md` STRIDE entry directly;
it's diagnostic input for a future entry about prover-time-based griefing cost, and for asset #2
(User Commitments) and #7 (Nullifier Set) in the sense that every one of those commitments/nullifiers
is a Poseidon call this experiment now prices exactly.

Assumptions carried over unchanged: Groth16 soundness under BN254 discrete log, Poseidon's own
security (round counts, S-box, MDS matrix) exactly as shipped in `circomlib`'s `poseidon.circom`
— this experiment does not touch, re-derive, or re-verify Poseidon's cryptographic parameters, only
counts the R1CS rows its circom implementation produces.

**Why no soundness argument / leakage analysis / negative test for a "circuit change":** this
experiment made no circuit change. The twelve probe circuits under `circuits/bench-probes/` are
throwaway measurement fixtures — each wraps exactly one existing, already-audited `circomlib`
component (or Veil's own `MerkleProof(20)`) in isolation with no new logic, is never included by
`transfer.circom`/`compliance.circom`/`withdraw.circom`, is never compiled into a deployed artifact,
and ships no verifying key. There is nothing here for a malicious witness to attack that isn't already
covered by the production circuits' own test suites (still 108/108 green — see Results).

## Approach

**What I built:** `scripts/bench/poseidon-decompose.mjs`, a reusable script that:

1. Compiles twelve isolated "probe" circuits (`circuits/bench-probes/probe_*.circom`), each
   instantiating exactly one gadget at the exact arity/width Veil's production circuits use:
   `Poseidon(2)`, `Poseidon(3)`, `Poseidon(4)`, `Poseidon(5)`, `Num2Bits(64)`, `Num2Bits(8)`,
   `GreaterThan(64)`, `LessEqThan(64)`, `GreaterEqThan(64)`, `GreaterEqThan(8)`, `MultiMux1(2)`, and
   the full `MerkleProof(20)` template (to check whether it decomposes cleanly into 20× its parts or
   hides extra cost).
2. Parses circom's own compile output (`non-linear constraints:` / `linear constraints:` / `wires:`)
   for each probe — the same fields `circuits/scripts/compile*.sh` already prints, not a separate
   metric.
3. Reconstructs each production circuit's total from a hand-verified table of gadget multiplicities
   (read directly off `transfer.circom`/`compliance.circom`/`withdraw.circom` source — one row per
   `component X = Gadget(...)` line) plus a small, explicit "glue" table for the top-level
   `===`/`<==` statements that aren't a named gadget call, and diffs the reconstructed total against
   `BASELINE.md`'s measured numbers.

**What I rejected.** The other reading of queue item #2 — actually swapping Poseidon for Poseidon2 in
a production circuit — was rejected for tonight for three reasons: (1) there is no vetted, audited
Poseidon2 circom implementation to port from reachable in this environment (GitHub access is scoped
to this repository only; `circomlib` itself doesn't ship one); (2) hand-deriving Poseidon2 round
constants and the partial-round MDS matrix from the paper and getting them right on a Groth16-verified
production circuit, in one night, without an established reference implementation to diff against, is
exactly the kind of unverified cryptographic surface the nightly rules warn against risking; (3) doing
the decomposition first is a prerequisite for that experiment being well-targeted at all — see the
Merkle-template finding below, which changes where a Poseidon2 swap should even focus.

I also rejected trying to estimate the breakdown analytically (e.g., "Poseidon2 papers claim ~40%
fewer constraints, so...") — the whole point of this loop is numbers from commands actually run, not
literature-derived guesses.

**Toolchain note (relevant to queue item #1, gas measurement, not this experiment):** `circom` was
unavailable again this session (fresh container) and was rebuilt from source — `git clone --depth 1
--branch v2.2.2 https://github.com/iden3/circom.git` followed by `cargo build --release`, same as
2026-07-22, confirming plain git-over-HTTPS to `github.com` works even though `api.github.com` and
`codeload.github.com` return `403` (GitHub App access is scoped to `alexandre-mrt/veil` only). Before
settling on tonight's experiment I spent the first part of the session trying to unblock on-chain gas
measurement (queue item #1) with this new information — see "Gas measurement — still BLOCKED" below
for what changed and what didn't.

## Results

### Per-gadget isolated constraint counts

`CIRCOM_BIN=<path> node scripts/bench/poseidon-decompose.mjs` (circom 2.2.2, built from source this
session; snarkjs 0.7.6 via `circuits/node_modules/.bin`):

```
=== Per-gadget isolated constraint counts ===

Poseidon(2)          non-linear:   243  linear:   274  wires: 520
Poseidon(3)          non-linear:   264  linear:   341  wires: 609
Poseidon(4)          non-linear:   300  linear:   436  wires: 741
Poseidon(5)          non-linear:   324  linear:   511  wires: 841
Num2Bits(64)         non-linear:    64  linear:     1  wires: 66
Num2Bits(8)          non-linear:     8  linear:     1  wires: 10
GreaterThan(64)      non-linear:    65  linear:     3  wires: 70
LessEqThan(64)       non-linear:    65  linear:     4  wires: 71
GreaterEqThan(64)    non-linear:    65  linear:     4  wires: 71
GreaterEqThan(8)     non-linear:     9  linear:     4  wires: 15
MultiMux1(2)         non-linear:     2  linear:     0  wires: 8
MerkleProof(20)      non-linear:  4920  linear:  5480  wires: 10422
```

`MerkleProof(20)` decomposes *exactly* into `20 × (Poseidon(2) + MultiMux1(2) + 1 binary-check row)`:
`20 × (243 + 2 + 1) = 4920` non-linear, `20 × (274 + 0) = 5480` linear. No hidden cost in the Merkle
template beyond its parts — but see below for why that 4,920 matters more than its four-line source
suggests.

### Reconstruction vs. `BASELINE.md`

```
=== Reconstruction vs BASELINE.md ===

transfer.circom
  non-linear: gadgets+glue 6470 vs actual 6470 (residual 0, fully explained)
  linear:     gadgets+glue 7141 vs actual 7141 (residual 0, fully explained)

compliance.circom
  non-linear: gadgets+glue 6057 vs actual 6057 (residual 0, fully explained)
  linear:     gadgets+glue 6686 vs actual 6686 (residual 0, fully explained)

withdraw.circom
  non-linear: gadgets+glue 1465 vs actual 1465 (residual 0, fully explained)
  linear:     gadgets+glue 1593 vs actual 1593 (residual 0, fully explained)
```

Every constraint in all three circuits is accounted for, exactly, by a named gadget instantiation or
one of three top-level "glue" statements (`GLUE` table in the script): `cumulativeNew ===
cumulativeOld + txAmount` and `remainingBalance <== cumulativeOld - withdrawAmount` each cost exactly
one linear row (they compute a genuine linear combination, so circom's default simplification can't
alias them away for free); `compliance.circom`'s two `x.out * (1 - x.out) === 0` binary checks plus
`computedValid <== expiryCheck.out * kycCheck.out` cost exactly one non-linear row each. Every other
top-level `===` in all three circuits (e.g. `oldCommitment === oldHash.out`) is a pure signal-to-signal
alias and costs nothing — circom's `-O1` default substitutes it away. This was verified empirically,
not assumed: the reconstruction only matched to zero residual once these were classified correctly (an
earlier pass that added a same-size "linear glue" row per `===` statement overshot `transfer.circom`'s
linear count by 7 and `compliance.circom`'s by 4, forcing the correction).

### Headline finding: Poseidon is 78–94% of non-linear cost, and the Merkle path is most of it

| Circuit | Total non-linear | Poseidon-family total | Poseidon share | `MerkleProof(20)` alone |
|---|---|---|---|---|
| `transfer.circom` | 6,470 | 6,024 (3×`Poseidon(4)` + 1×`Poseidon(3)` + 20×`Poseidon(2)` in the Merkle path) | **93.1%** | 4,920 (76.0% of total) |
| `compliance.circom` | 6,057 | 5,712 (1×`Poseidon(5)` + 2×`Poseidon(3)` + 20×`Poseidon(2)` in the Merkle path) | **94.3%** | 4,920 (81.2% of total) |
| `withdraw.circom` | 1,465 | 1,143 (3×`Poseidon(4)` + 1×`Poseidon(2)`, no Merkle proof) | **78.0%** | n/a |

The 2026-07-22 report's own framing — "four Poseidon instances dominate `transfer.circom`'s and
`compliance.circom`'s non-linear constraints" — undercounts by a factor of six. Both circuits' source
comments enumerate 4–5 *named* Poseidon calls, but each also embeds a `MerkleProof(20)`, which is 20
more `Poseidon(2)` calls the top-level comments never mention. Those 20 hidden calls alone are 76–81%
of the two circuits' entire non-linear budget — more than all the named domain-tag hashes combined.
`withdraw.circom` has no Merkle proof (by design — it's the identifiable exit path, not part of the
anonymity set) and Poseidon still dominates at 78%, but far less lopsidedly.

This directly changes where a future Poseidon2 experiment should aim: swapping the four named
domain-tag hashes (`Poseidon(3)`/`Poseidon(4)`/`Poseidon(5)`) would touch at most ~24% of
`transfer.circom`'s non-linear constraints and ~19% of `compliance.circom`'s. Swapping the
Merkle-path hasher (`Poseidon(2)`, called 20× per proof) is the actual highest-leverage target in
both circuits that carry one.

### Test suite (full run, from `README.md`)

| Suite | Result | Command |
|---|---|---|
| `transfer.circom` (real Groth16) | **43/43 pass** | `node --experimental-vm-modules test/transfer.test.mjs` |
| `compliance.circom` (real Groth16) | **30/30 pass** | `node --experimental-vm-modules test/compliance.test.mjs` |
| `withdraw.circom` (real Groth16) | **35/35 pass** | `node --experimental-vm-modules test/withdraw.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils (incl. depth-20 Merkle build) | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Property-based fuzz | **6/6 properties × 500 cases** | `cd scripts && bun run src/fuzz-tests.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bun run test` |
| Move contracts (124 tests) | **NOT RUN** | `sui` CLI unavailable — see below |

No test was loosened, skipped, or given new tolerance. `test-compliance-utils.ts`'s depth-20 Merkle
build (2^20 = 1,048,576 leaves, real Poseidon per leaf) legitimately takes several minutes of
wall-clock — it is not the same "process won't exit" symptom filed against the circuit test suite in
the 2026-07-22 report; it completes and exits 0 given enough time (confirmed with a 500s timeout after
a 150s run was killed mid-computation).

### Gas measurement (queue item #1) — still BLOCKED, with a sharper diagnosis

Before starting tonight's experiment I spent time trying to unblock queue item #1, since
`EXPERIMENTS.md` flagged it as worth an early attempt. Three concrete things changed from the
2026-07-22 attempt, none of which close it:

```
$ curl -sS --max-time 20 -X POST https://fullnode.testnet.sui.io:443 -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"sui_getObject","params":["0x6ba8019987c7c5d02d2c2b11e0eddd491428d0cc6bbed05ab79760e069ce913a", {"showType":true}]}'
curl: (56) CONNECT tunnel failed, response 403

$ curl http://127.0.0.1:46839/__agentproxy/status   # recentRelayFailures
{"kind":"connect_rejected","detail":"gateway answered 403 to CONNECT (policy denial or upstream failure)","host":"fullnode.testnet.sui.io:443"}

$ cargo install sui
    Downloaded sui v0.0.1
error: there is nothing to install in `sui v0.0.1`, because it has no binaries

$ cargo install circom
error: could not find `circom` in registry `crates-io` with version `*`
```

- Direct JSON-RPC to the public testnet fullnode is now a confirmed, explicit network-policy denial
  (403 on the CONNECT tunnel itself, logged by the egress proxy), not the ambiguous "sandbox
  tool-approval layer" denial from 2026-07-22. Per this session's own instructions, an org-policy 403
  is not retried.
- `crates.io` has a placeholder package literally named `sui` (v0.0.1, no binaries) — confirmed
  dead end, not worth another night rediscovering.
- `circom` is not on `crates.io` at all under that name (the real compiler is only distributed via
  the `iden3/circom` GitHub repo, which is why building it from source, as this experiment does, is
  the only path).
- One thing *did* newly work: plain `git clone https://github.com/...` succeeds even for repositories
  outside this session's GitHub-App scope (`api.github.com`/`codeload.github.com` are blocked at
  403, but the git smart-HTTP backend on `github.com` itself is not) — that's how tonight's `circom`
  rebuild happened. This reopens (in principle) building the `sui` CLI from source, but the 2026-07-22
  judgment that a full Sui-workspace build (validator, Move VM, RocksDB, ...) is impractical to
  attempt and verify honestly within one night's budget still stands; I did not attempt it, since
  tonight's chosen experiment doesn't touch Move contracts and a half-verified `sui` build would be
  worse than an honest BLOCKED.

Gas per entry point remains **BLOCKED**, now for fully diagnosed reasons rather than partially-explored
ones. Re-ranked but not resolved — see `EXPERIMENTS.md`.

## Verdict: **KEEP**

The per-gadget constraint breakdown is real, reproducible (`scripts/bench/poseidon-decompose.mjs`,
checked into the repo, re-runnable against any future circuit edit — a nonzero residual is a built-in
canary that the `GLUE` table needs updating), and answers a real open question from the last research
night with an exact number instead of a guess. It changes the target for the next Poseidon2 experiment
materially: the Merkle-path hasher, not the four named domain-tag hashes, is where 76–81% of the
relevant circuits' non-linear cost actually lives.

No `BASELINE.md` row is superseded (the totals are unchanged — this decomposes an existing baseline
number, it doesn't remeasure it), so I added a new "Non-linear constraint breakdown by gadget" section
to `BASELINE.md` rather than replacing anything.

## Where this could be used

- **Any Circom/Groth16 protocol with a Merkle-membership circuit** (privacy pools, anonymity sets,
  credential accumulators) — the "your source comments count named hash calls but not the ones
  hiding inside your Merkle-path template" trap this experiment surfaced is generic to the pattern,
  not specific to Veil's three circuits.
- **A thesis chapter arguing for recursive/folded Merkle proofs or a shallower tree** — this gives the
  exact per-level cost (243 non-linear constraints per Poseidon(2) hash × depth) needed to quantify
  the anonymity-set-size vs. proving-time trade-off `EXPERIMENTS.md` item #4 already flags, instead of
  citing Poseidon's abstract constraint count.
- **Anyone benchmarking a hash-function swap in an existing circuit** — the ablation method here
  (isolate each gadget, reconstruct the whole, require zero residual) generalizes directly: it is how
  you'd validate a Poseidon2 swap's actual delta once one is built, and it is how you'd catch a
  compiler-version regression that silently changes constraint counts.

## Open questions (next queue)

1. **Poseidon2 for the Merkle-path hasher specifically** — now that it's confirmed to be 76–81% of
   the two anonymity-set circuits' non-linear cost, a Poseidon2 swap scoped to `MerkleProof`'s
   internal `Poseidon(2)` calls (not the four named domain-tag hashes) is the highest-leverage version
   of queue item #2's other framing. Needs a vetted Poseidon2 circom reference to port from — the
   blocker this experiment ran into for a full swap.
2. **Per-level Merkle depth vs. proving-time trade-off** (`EXPERIMENTS.md` item #4) can now cite an
   exact per-level cost (243 non-linear / 274 linear constraints per level) instead of an estimate —
   worth folding into that experiment directly rather than re-deriving it.
3. **Gas measurement (queue item #1)** remains top of the queue, now with `git clone` to arbitrary
   GitHub repos confirmed to work as a new option — a future night could budget specifically for
   attempting a `sui` CLI source build (or a minimal subset of it sufficient for `sui client
   call`/gas introspection) rather than ruling it out on the first look.
4. Does the "pure alias vs. linear-combination vs. product" classification this experiment used to
   explain the linear/non-linear residual generalize to a rule of thumb ("count each `<==`/`===`
   involving a `+`, `-`, or `*` operator as one extra constraint row, ignore direct signal aliases"),
   or was it coincidental to these three circuits? Worth checking against a fourth, structurally
   different circuit before treating it as a general circom-optimizer fact.
