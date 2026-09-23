# 2026-09-23 — Poseidon's real share of Veil's non-linear constraint count (queue item #2, alternate form)

## Hypothesis

Poseidon hashing — including the depth-20 Merkle membership check, which is itself built entirely
out of Poseidon(2) calls — accounts for the overwhelming majority of non-linear R1CS constraints in
`transfer.circom` and `compliance.circom` (more than all range checks and comparators combined), and
circom's default optimization level makes non-linear constraint count *exactly* additive across
gadget instantiations, so a circuit's non-linear constraint count can be predicted exactly from its
gadget inventory alone, without compiling the whole circuit. Both halves of this are falsifiable: the
Poseidon share could have come out under 50%, and the predicted-vs-actual sum could have diverged
by more than rounding.

This is queue item #2 in its explicitly-permitted alternate form ("or re-deriving the exact
non-linear-constraint contribution per Poseidon instance from the current baseline"), taken instead
of porting Poseidon2 itself — see **Approach** for why.

## Threat / privacy model

No adversary model changes here — this is diagnostic tooling, not a protocol change. Nothing in
`transfer.circom`, `compliance.circom`, `withdraw.circom`, `templates/merkle_proof.circom`, or any
Move module was modified. `scripts/bench/poseidon-cost/circuits/merkleproof{10,20,30}.circom` each
`include` the real, unmodified `circuits/templates/merkle_proof.circom` — they are not copies, so
there is no risk of the benchmark drifting from what's deployed. The other gadget benchmarks isolate
single circomlib components (`Poseidon`, `Num2Bits`, `GreaterThan`, `LessEqThan`, `GreaterEqThan`)
that are also unmodified, directly from `circuits/node_modules/circomlib`.

The relevant framing, same as the 2026-07-22 baseline report: **who relies on these numbers being
honest.** Every future circuit-optimization experiment in this loop (a real Poseidon2 port chief
among them) now has a precise, reproducible answer to "how much would optimizing Poseidon actually
save?" — 78–95% of non-linear constraints, depending on the circuit. A wrong number here would send
a future night chasing the wrong optimization (e.g. spending effort on range-check batching, which
this run shows caps out at a 4.7–22% ceiling depending on the circuit, when Poseidon is where the
leverage is).

What this does **not** establish: it says nothing about whether swapping to Poseidon2 is *safe* — that
requires an actual, independently-verified implementation and its own soundness argument, which this
experiment deliberately does not attempt (see Approach). It doesn't touch `docs/threat-model.md`'s
Merkle accumulator entry (I6, RR5, the "Merkle accumulator" control row) — the accumulator's privacy
properties are unchanged, only its constraint cost is now quantified per depth level. Assumptions
carried over unchanged: Groth16/BN254 soundness, the existing dev-only trusted setup (RR2), Poseidon's
(not Poseidon2's) security as currently used.

## Approach

**What I built.** `scripts/bench/poseidon-cost/`:

- `circuits/poseidon{2,3,4,5}.circom`, `num2bits{64,8}.circom`, `{greaterthan,lesseqthan,greaterequalthan}64.circom`,
  `greaterequalthan8.circom`, `merkleproof{10,20,30}.circom` — one gadget per file, each a minimal
  `component main` wrapper around the exact circomlib/template component the real circuits use, at
  the exact arity/width used. No new circuit logic; these are pure isolation harnesses.
- `constraint-breakdown.mjs` — compiles every gadget file and all three real circuits with the same
  `circom` binary and the same flags (`--r1cs`, default `--O1`, matching `circuits/scripts/compile*.sh`,
  which pass no explicit optimization flag), parses circom's own non-linear/linear breakdown from
  stdout (not `snarkjs r1cs info`, which only reports the combined total), and computes a predicted
  total per real circuit from a hand-written gadget inventory (component counts read directly off
  each `.circom` file, cited by component name in the script) plus a small number of hand-counted
  primitive R1CS constraints (multiplications, boolean-enforcement checks) that aren't gadget calls.
  It then prints predicted vs. actual and a Merkle-depth scaling check.

**What I rejected — and why this isn't a Poseidon2 port.** The original queue item's primary framing
was "measured constraint-count and proving-time delta from swapping to Poseidon2." I looked for an
existing, reviewable circom implementation of Poseidon2 rather than hand-deriving BN254 round
constants myself (a classic place for a subtle, security-critical transcription error). `npm` has
JS/TS Poseidon2 implementations (`poseidon2`, `@zkpassport/poseidon2`, `@taceo/poseidon2`) but none
of them ship a circom gadget — Poseidon2 circom implementations exist in various GitHub repos, but
`api.github.com` (code search) returns `403` through this session's egress proxy (organization
policy, not retried — see below), so I could not search for one; guessing repository URLs against
`raw.githubusercontent.com` (which is reachable) is not a responsible way to source a cryptographic
primitive for a payment protocol, even on a research branch — an unverified circom file is a
plausible supply-chain vector, and "I found something that compiled" is not the same as "the round
constants are correct." I did not attempt to derive Poseidon2's round constants from the paper
by hand either, for the same reason: getting BN254 round constants wrong doesn't fail loudly, it
produces a hash function with unknown security properties.

Given that, I took the queue item's explicitly-listed alternate path: quantify exactly what a
successful Poseidon2 port would be worth, with real numbers, so that effort is justified (or not)
*before* anyone spends a night sourcing and verifying an implementation. That's what this experiment
does.

**Queue item #1 (on-chain gas), re-confirmed blocked.** Before starting this experiment I spent a
few minutes re-checking whether last night's blockers on the `sui` CLI / JSON-RPC fallback had
changed. They haven't, and I got one new, more conclusive data point: a direct `suix_queryTransactionBlocks`
call against `fullnode.testnet.sui.io` (the fallback path from the 2026-07-22 report) now fails with
an explicit proxy-level `403` — the egress proxy's own diagnosis for that code is "destination host
is not allowed by your organization's egress policy for this session... do not retry or route
around it," which is a stronger, more permanent signal than last night's tool-approval-layer denial.
`apt-cache search sui` and the `crates.io` index (an allow-listed, unproxied host) both confirm no
`sui` CLI package is available here either — the `sui` crate on crates.io is an unrelated squatted
name (published 2022, zero deps, nothing to do with Mysten Labs). I did not retry `github.com`
release downloads, since that exact host was already denied last night and retrying a policy denial
is against the standing instructions for this loop. On-chain gas remains **BLOCKED** for the same
underlying reason as 2026-07-22: no reachable path to a `sui` binary or a Sui RPC endpoint from this
sandbox. I did not spend further budget on it tonight beyond this reconfirmation — see **Open
questions**.

## Results

### Standalone gadget cost (non-linear constraints, circom 2.2.2, default `--O1`)

| Gadget | Non-linear | Linear |
|---|---|---|
| `Poseidon(2)` | 243 | 274 |
| `Poseidon(3)` | 264 | 341 |
| `Poseidon(4)` | 300 | 436 |
| `Poseidon(5)` | 324 | 511 |
| `Num2Bits(64)` | 64 | 1 |
| `Num2Bits(8)` | 8 | 1 |
| `GreaterThan(64)` | 65 | 3 |
| `LessEqThan(64)` | 65 | 4 |
| `GreaterEqThan(64)` | 65 | 4 |
| `GreaterEqThan(8)` | 9 | 4 |
| `MerkleProof(20)` | 4,920 | 5,480 |

### Predicted (sum of standalone gadget costs, per the source-cited inventory) vs. actual

| Circuit | Predicted non-linear | Actual non-linear | Delta | Poseidon share of actual |
|---|---|---|---|---|
| `transfer.circom` | 6,470 | 6,470 | **+0 (0.00%)** | 6,084 / 6,470 (**94.0%**) |
| `compliance.circom` | 6,057 | 6,057 | **+0 (0.00%)** | 5,772 / 6,057 (**95.3%**) |
| `withdraw.circom` | 1,465 | 1,465 | **+0 (0.00%)** | 1,143 / 1,465 (**78.0%**) |

Predicted matches actual exactly for all three circuits — non-linear constraint count is fully
additive across component boundaries under circom's default `--O1` (only signal-to-signal/constant
simplification; no cross-component elimination), which is exactly the flag `compile*.sh` already
uses. "Poseidon share" counts `MerkleProof(20)` as Poseidon cost, since 4,920 of its 4,920 non-linear
constraints are 20× `Poseidon(2)` (243 × 20 = 4,860) plus 20× `MultiMux1(2)` (3 each = 60); the
membership check has no non-Poseidon cost worth separating out.

Non-Poseidon share, for contrast: `transfer.circom` 386/6,470 (6.0%, from `GreaterThan(64)` +
4×`Num2Bits(64)` + `LessEqThan(64)`), `compliance.circom` 285/6,057 (4.7%), `withdraw.circom`
322/1,465 (22.0%, the one circuit without a Merkle check).

### Bonus: Merkle depth vs. constraint cost (queue item #4)

| Merkle depth | Anonymity set | Non-linear constraints | Per-level delta |
|---|---|---|---|
| 10 | 2^10 | 2,460 | — |
| 20 | 2^20 | 4,920 | 246.0 |
| 30 | 2^30 | 7,380 | 246.0 |

Exactly linear (246.0 constraints/level measured identically across both deltas, and 246 × depth
equals the total exactly at all three sampled points) — each additional level of anonymity-set depth
costs exactly one more `Poseidon(2)` (243) + `MultiMux1(2)` (3) non-linear constraints, with zero
per-level overhead beyond that. Scaling the anonymity set is cheap and perfectly predictable in
constraint terms; whether that translates linearly into *proving time* is not measured here (see
Open questions).

### Raw command output

Full raw output (every `circom`/`snarkjs` invocation, unedited) is reproduced by running the script
below; representative excerpts:

```
$ node scripts/bench/poseidon-cost/constraint-breakdown.mjs
=== Veil Poseidon-vs-everything-else constraint breakdown ===
circom compiler 2.2.2

--- Standalone gadget costs ---

$ circom scripts/bench/poseidon-cost/circuits/poseidon4.circom --r1cs -l circuits -l circuits/node_modules
template instances: 75
non-linear constraints: 300
linear constraints: 436
public inputs: 0
private inputs: 4
public outputs: 1
wires: 741
labels: 1173
Written successfully: .../poseidon4.r1cs
Everything went okay

-> Poseidon(4): 300 non-linear, 436 linear

[... poseidon2/3/5, num2bits64/8, the four comparators, merkleproof10/20/30 — same shape ...]

--- Real circuits (measured directly, same compiler, same flags) ---

$ circom transfer.circom --r1cs -l circuits/node_modules (from circuits/)
non-linear constraints: 6470
linear constraints: 7141
...
-> transfer: 6470 non-linear, 7141 linear

$ circom compliance.circom --r1cs -l circuits/node_modules (from circuits/)
non-linear constraints: 6057
linear constraints: 6686
...
-> compliance: 6057 non-linear, 6686 linear

$ circom withdraw.circom --r1cs -l circuits/node_modules (from circuits/)
non-linear constraints: 1465
linear constraints: 1593
...
-> withdraw: 1465 non-linear, 1593 linear

--- Predicted (sum of standalone gadget costs) vs actual ---

| Circuit | Predicted non-linear | Actual non-linear | Delta | Delta % | Poseidon share of actual |
|---|---|---|---|---|---|
| `transfer.circom` | 6470 | 6470 | +0 | 0.00% | 6084 (94.0%) |
| `compliance.circom` | 6057 | 6057 | +0 | 0.00% | 5772 (95.3%) |
| `withdraw.circom` | 1465 | 1465 | +0 | 0.00% | 1143 (78.0%) |

--- Bonus: does Merkle depth cost scale linearly? (queue item #4) ---

| Merkle depth | Anonymity set (2^depth) | Non-linear constraints | Per-level (this - previous) / 10 |
|---|---|---|---|
| 10 | 2^10 | 2460 | - |
| 20 | 2^20 | 4920 | 246.0 |
| 30 | 2^30 | 7380 | 246.0 |
```

(Full untruncated output for every gadget and every real circuit was captured in this session's run
and matches the tables above exactly; reproduce with the exact command shown, requires `circom` on
`PATH` — see the script's header comment for how to build it if not already installed.)

### Toolchain note: `circom` was not pre-installed

Same as 2026-07-22: `circom` is not on `PATH` and has no `apt`/`crates.io` package here. Rebuilt from
source the same way as last night — `git clone --depth 1 --branch v2.2.2 https://github.com/iden3/circom.git`
then `cargo build --release` (`github.com` itself, unlike `api.github.com` and the release-download
path, is reachable for a plain clone; build took ~1 minute) — and used the built binary directly
rather than trying to install it onto `PATH` system-wide.

### Test suite

Since no protocol circuit, Move module, or frontend code was touched (only new files under
`scripts/bench/poseidon-cost/`), the regression surface is limited to "did adding these files break
anything else" — nothing in the new directory is imported by anything else in the repo.

| Suite | Result | Command |
|---|---|---|
| `transfer.circom` (circomlibjs fallback mode) | **43/43 pass** | `cd circuits && node --experimental-vm-modules test/transfer.test.mjs` |
| `compliance.circom` (circomlibjs fallback mode) | **30/30 pass** | `cd circuits && node --experimental-vm-modules test/compliance.test.mjs` |
| `withdraw.circom` (circomlibjs fallback mode) | **35/35 pass** | `cd circuits && node --experimental-vm-modules test/withdraw.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bun run test` |
| Compliance utils | see note | `cd scripts && bun run src/test-compliance-utils.ts` |
| Move contracts | **NOT RUN** — `sui` CLI unavailable | `cd contracts && sui move test` |

Fallback mode (circomlibjs constraint simulation, not real Groth16 proving) was used for the circuit
tests: the real-proving mode needs a downloaded Powers-of-Tau file, and `storage.googleapis.com`
(the ptau host `compile.sh` already uses) returns the same proxy-level `403` as `fullnode.testnet.sui.io`
tonight — also organization-policy-blocked, also not retried. This is an unrelated, pre-existing
network restriction, not something this experiment's file additions caused; per the README, fallback
mode is "a linting aid, not evidence" for full-proof correctness, but it is a real regression check
for whether the existing witness-generation logic still validates, and it's green.

Move contract tests were not run for the same reason as 2026-07-22 (`sui` CLI unavailable); no Move
code changed this session so the risk from skipping is unchanged from the existing baseline.

## Verdict: **KEEP**

`scripts/bench/poseidon-cost/` is a real, reusable, checked-in tool that answers a question every
future circuit-optimization night in this loop needs answered: does a given proposed change actually
move the needle on non-linear constraints, and by how much relative to the whole circuit? Tonight it
answers the specific question the queue asked — Poseidon accounts for 78–95% of non-linear
constraints across Veil's three circuits, confirmed by an exact predicted-vs-actual match, not an
estimate. That's now a citable, reproducible precondition for the still-open Poseidon2 experiment:
whatever fraction Poseidon2 shaves off Poseidon's constraint count carries through almost directly to
total proving time, because Poseidon so thoroughly dominates. The bonus Merkle-depth measurement
(exactly 246.0 non-linear constraints per level, confirmed at two depth deltas) is a first real
number for queue item #4's anonymity-set-size tradeoff.

Queue item #1 (on-chain gas) stays **BLOCKED**, now with a firmer signal (explicit proxy-policy `403`
on the RPC fallback, not just a one-off tool-approval denial) — see Open questions for what would
actually unblock it.

## Where this could be used

- **Any Circom/Groth16 circuit design review**, not just Veil's: "isolate every gadget, compile
  standalone, sum, compare to the real circuit" is a cheap, general sanity check that catches both
  "did I miscount my own gadget inventory" and "does my optimization flag actually behave the way I
  assumed" (the exact-additivity result here is itself evidence that `--O1` doesn't do cross-component
  CSE — worth knowing before assuming a refactor that splits a component in two is free).
- **A thesis chapter arguing for or against a hash-function swap in a SNARK circuit** needs exactly
  this shape of before-you-build-it argument: quantify the ceiling before spending the implementation
  and audit budget. "Poseidon is 94% of this circuit's non-linear cost" is a much stronger opening
  than "Poseidon2 papers claim it's faster."
- **Any protocol pricing a Merkle-based anonymity set on Sui or another Move chain** (confidential
  payroll with a growing employee set, a compliance-gated pool with a growing KYC'd-user set) gets a
  free, exact answer to "what does one more bit of anonymity-set size cost in prover-side
  constraints" from the depth-scaling table — 246 constraints per level, no circuit-specific
  measurement needed beyond confirming the same Poseidon(2)-based Merkle template is in use.

## Open questions (next queue)

1. **Actually port Poseidon2 and measure the real delta.** Now justified with real numbers (78–95%
   of non-linear constraints are Poseidon-addressable) rather than an assumption. Needs either (a) an
   independently-verified circom implementation sourced properly — which likely means asking for
   `api.github.com` access for code search, or explicit permission to trust a specific named,
   citable repository, rather than guessing — with its output cross-checked against at least one
   independent reference implementation (e.g. `@zkpassport/poseidon2` or `@taceo/poseidon2` on npm,
   both reachable) on known test vectors before it goes anywhere near a circuit, or (b) hand-deriving
   BN254 round constants from the Poseidon2 paper with the same cross-check discipline. Either way,
   correctness verification against an independent source is not optional for a hash function
   swap — this is exactly the kind of change that needs the full soundness-argument treatment the
   loop's instructions require for circuit changes.
2. **On-chain gas per entry point** — still top-blocked. What would actually unblock it: either
   `api.github.com`/release-download access for `github.com/MystenLabs/sui` (to get a prebuilt `sui`
   binary or search for one), or an explicit egress-policy allowance for `fullnode.testnet.sui.io`
   (a single JSON-RPC read-only host). Building the full Sui workspace from source remains judged
   impractical for a single night's budget, unchanged from 2026-07-22.
3. **Does the 246 constraints/level Merkle-depth cost translate linearly into proving time too?**
   Constraint count and proving time were shown *not* to scale identically in the 2026-07-22 baseline
   (13,611 vs. 3,058 constraints is a 4.45× ratio; 751.9ms vs. 244.3ms proving time is only 3.08×).
   A cheap follow-up: full Groth16 setup + `prove-latency.mjs`-style timing for `MerkleProof(10)`,
   `MerkleProof(20)`, `MerkleProof(30)` standalone circuits — same shape as tonight's constraint
   measurement, but needs the ptau file, which is blocked by the same `storage.googleapis.com` 403
   as tonight's fallback-mode test runs. Worth revisiting alongside item 2.
4. Given non-linear constraints are exactly additive under `--O1`, would `--O2` ("full constraint
   simplification") change that story — i.e. does full simplification find real cross-component
   savings in these circuits, or is Poseidon's output already too high-entropy for algebraic
   simplification to help? A cheap one-script-flag-change follow-up.
