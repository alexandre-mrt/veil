# 2026-08-06 — Non-linear constraint decomposition, per gadget (queue item #2, partial)

## Hypothesis

`BASELINE.md`'s three whole-circuit non-linear-constraint totals (6,470 / 6,057 / 1,465 for
transfer / compliance / withdraw) can be decomposed into an exact, measured, per-gadget attribution
— N instances of Poseidon at each arity actually used, the depth-20 `MerkleProof` template, four
`Num2Bits(64)` range checks, two comparators — by compiling each gadget alone and summing. If that
decomposition reconciles to the whole-circuit total (it does, exactly or within a small, fully
explained residual), it replaces a guess about "which gadget to optimize first" with a real number,
and it overturns `EXPERIMENTS.md` item #2's framing: the claim there is that "four Poseidon
instances dominate" `transfer.circom` and `compliance.circom`. The decomposition below shows that's
wrong for those two circuits specifically — it's the 20 `Poseidon(2)` calls chained inside the
Merkle-membership proof that dominate (76–81%), not the four domain-tagged top-level calls
(14–18%). `withdraw.circom`, which has no Merkle proof, is the one circuit where the top-level
Poseidon calls really do dominate (78%).

This is queue item #2's own stated alternative ("re-deriving the exact non-linear-constraint
contribution per Poseidon instance from the current baseline"), not the full Poseidon2 swap itself.
**No production circuit was modified.** `transfer.circom`, `compliance.circom`, and
`withdraw.circom` are byte-for-byte unchanged.

## Threat / privacy model

No adversary model changes — this is a measurement night against unmodified circuits, same
framing as the 2026-07-22 baseline report.

- **Concrete adversary:** none directly. Nothing about soundness, privacy, or trust boundaries
  moved. The people who rely on this being honest are **this research loop's future nights**: any
  Poseidon2 experiment that follows needs to know it should target the Merkle hasher, not the
  commitment/nullifier hashers, or it will spend a multi-night circuit-rewrite effort on a swap
  that saves 14–18% instead of 76–81%.
- **What this does NOT establish:** whether 6,470 non-linear constraints is "good," whether
  Poseidon2 (not implemented here) would actually beat standard Poseidon at arity 2 on this specific
  toolchain, or anything about gas, proving time deltas, or anonymity-set trade-offs at other Merkle
  depths — those stay exactly as unmeasured as they were before tonight.
- **Assumptions:** unchanged — Groth16/BN254 soundness, dev-only trusted setup (RR2, untouched).
- **STRIDE mapping:** maps to no entry in `docs/threat-model.md` directly (no circuit changed). It
  is a prerequisite for evaluating any future change to RR5 (deposit-commitment linkability /
  Merkle depth vs anonymity-set size) — that trade-off can't be costed without knowing the
  per-Merkle-level constraint price, which this experiment establishes as **246 non-linear
  constraints/level** (see Results).

Because no circuit changed, the deliverable this PR requires for circuit changes (soundness
argument, leakage analysis, negative test) does not apply — there is nothing new to attack. The new
files are eleven single-gadget benchmark circuits under `circuits/bench/` that are not included by
`transfer.circom`, `compliance.circom`, or `withdraw.circom`, and are not part of the deployed
protocol.

## Approach

**What I built.**

- Eleven isolated one-gadget circuits under `circuits/bench/`: `poseidon2.circom` through
  `poseidon5.circom` (one `Poseidon(N)` call each, N = 2..5 — every arity actually used across the
  three production circuits), `merkle20.circom` (the exact `MerkleProof(20)` template used by
  `transfer.circom` and `compliance.circom`, compiled standalone), `num2bits64.circom`,
  `num2bits8.circom`, `lesseqthan64.circom`, `greaterthan64.circom`, `greaterequalthan64.circom`,
  `greaterequalthan8.circom` — one `component main` per file, no glue logic.
- `scripts/bench/gadget-constraints.sh` — compiles each of the eleven and greps the circom
  compiler's own `non-linear constraints` / `linear constraints` lines, the same two lines
  `circuits/scripts/compile.sh` already prints per circuit. Reusable for any future gadget
  (Poseidon2, a different Merkle depth, a different comparator width).

**What I rejected.** Temporarily commenting out lines in the real `transfer.circom` /
`compliance.circom` / `withdraw.circom` and diffing constraint counts before/after each removal —
rejected because it requires repeatedly mutating production circuit files (risk of a leftover edit
surviving into a commit), and because circom's constraint count for a partial circuit with dangling
signal references is not always a clean subtraction (unconstrained signals get flagged or silently
folded). Isolated single-gadget circuits give an unambiguous, individually reproducible number per
gadget instead.

**Toolchain note — a real change from 2026-07-22.** Last night's report cloned `iden3/circom`
(GitHub, tag `v2.2.2`) and built it with `cargo build --release`. This session, `github.com` and
`crates.io` both returned `403` through the network proxy (`$HTTPS_PROXY/__agentproxy/status`
reports these as explicit gateway policy denials, not transient failures — the proxy's own guidance
is "do not retry or route around it," so I didn't). `cargo install circom` also fails: no crate
named `circom` is published (`cargo search circom` lists only libraries built *around* circom —
`circom-witness-rs`, `ark-circom`, etc. — not the compiler itself). What worked instead:
**`npm install --no-save circom2`** — a WASM build of the same compiler, published on
`registry.npmjs.org` (which this proxy does allow), reporting `circom compiler 2.2.3`. I recompiled
`transfer.circom` with it before touching anything else and it reproduced `BASELINE.md`'s numbers
exactly (13,611 constraints / 6,470 non-linear / 7,141 linear / 13,632 wires) — see Results. This is
worth carrying forward: it removes the from-source-build step (and its GitHub/cargo dependency)
from every future night's setup, using only the npm registry this sandbox already trusts.

## Results

### Sanity check — fresh compile of all three production circuits, this session's toolchain

```
$ npx circom2 transfer.circom --r1cs -o build-sanity -l node_modules
template instances: 221
non-linear constraints: 6470
linear constraints: 7141
public inputs: 7
private inputs: 47
public outputs: 0
wires: 13632
labels: 20437
Written successfully: build-sanity/transfer.r1cs

$ npx snarkjs r1cs info build-sanity/transfer.r1cs
[INFO]  snarkJS: # of Wires: 13632
[INFO]  snarkJS: # of Constraints: 13611
[INFO]  snarkJS: # of Private Inputs: 47
[INFO]  snarkJS: # of Public Inputs: 7
```

Exact match with `BASELINE.md` (2026-07-22, built from source). `circom2`'s WASM build and a
from-source `cargo build` of the native compiler produce byte-identical constraint counts.

### Gadget costs (raw `circom` compiler output, `bash scripts/bench/gadget-constraints.sh`)

| Gadget | Non-linear | Linear | Wires |
|---|---|---|---|
| `Poseidon(2)` | 243 | 274 | 520 |
| `Poseidon(3)` | 264 | 341 | 609 |
| `Poseidon(4)` | 300 | 436 | 741 |
| `Poseidon(5)` | 324 | 511 | 841 |
| `MerkleProof(20)` (20× `Poseidon(2)` + `MultiMux1(2)` selectors) | 4,920 | 5,480 | 10,422 |
| `Num2Bits(64)` | 64 | 1 | 66 |
| `Num2Bits(8)` | 8 | 1 | 10 |
| `LessEqThan(64)` | 65 | 4 | 71 |
| `GreaterThan(64)` | 65 | 3 | 70 |
| `GreaterEqThan(64)` | 65 | 4 | 71 |
| `GreaterEqThan(8)` | 9 | 4 | 15 |

Raw output:

```
$ bash scripts/bench/gadget-constraints.sh
circom: circom2 npm package 0.2.23 circom compiler 2.2.3

############ poseidon2 ############
template instances: 72
non-linear constraints: 243
linear constraints: 274

############ poseidon3 ############
template instances: 71
non-linear constraints: 264
linear constraints: 341

############ poseidon4 ############
template instances: 75
non-linear constraints: 300
linear constraints: 436

############ poseidon5 ############
template instances: 75
non-linear constraints: 324
linear constraints: 511

############ merkle20 ############
template instances: 73
non-linear constraints: 4920
linear constraints: 5480

############ num2bits64 ############
template instances: 1
non-linear constraints: 64
linear constraints: 1

############ num2bits8 ############
template instances: 1
non-linear constraints: 8
linear constraints: 1

############ lesseqthan64 ############
template instances: 3
non-linear constraints: 65
linear constraints: 4

############ greaterthan64 ############
template instances: 3
non-linear constraints: 65
linear constraints: 3

############ greaterequalthan64 ############
template instances: 3
non-linear constraints: 65
linear constraints: 4

############ greaterequalthan8 ############
template instances: 3
non-linear constraints: 9
linear constraints: 4
```

`MerkleProof(20)` vs. 20× standalone `Poseidon(2)`: 4,920 vs. 20 × 243 = 4,860 — a 60-constraint
(3/level) overhead from the `MultiMux1(2)` left/right selector at each level. **246 non-linear
constraints per Merkle level, of which 243 (98.8%) is the hash and 3 (1.2%) is the selector** — any
future Merkle-depth or hash-arity decision should optimize the hash, not the mux.

### Per-circuit decomposition (gadget count × cost, reconciled against `BASELINE.md`'s whole-circuit totals)

**`transfer.circom`** — `MerkleProof(20)`×1, `Poseidon(4)`×3, `Poseidon(3)`×1, `Num2Bits(64)`×4,
`GreaterThan(64)`×1, `LessEqThan(64)`×1 (gadget instances counted directly from source: `grep -oE
'=\s*(Poseidon|Num2Bits|LessEqThan|GreaterThan|MerkleProof)\([0-9a-zA-Z]*\)\s*;' transfer.circom`):

| Contribution | Non-linear | % of 6,470 |
|---|---|---|
| `MerkleProof(20)` | 4,920 | 76.05% |
| `Poseidon(4)` × 3 (`oldHash`, `newHash`, `nfHash`) | 900 | 13.91% |
| `Poseidon(3)` × 1 (`txHash`) | 264 | 4.08% |
| `Num2Bits(64)` × 4 | 256 | 3.96% |
| `GreaterThan(64)` × 1 | 65 | 1.00% |
| `LessEqThan(64)` × 1 | 65 | 1.00% |
| **Sum** | **6,470** | **100.00%** |

Sum matches `BASELINE.md`'s 6,470 exactly — zero unattributed non-linear constraints. Linear sum:
5,480 + 3×436 + 341 + 4×1 + 3 + 4 = **7,140** vs. `BASELINE.md`'s actual 7,141 — off by exactly 1,
attributable to `cumulativeNew === cumulativeOld + txAmount` (C3), the one top-level assertion
that's a real arithmetic relation rather than a pure signal alias (every other `===` — commitment
equality, nullifier equality, root equality — is absorbed by circom's optimizer at zero additional
linear-constraint cost).

**`compliance.circom`** — `MerkleProof(20)`×1, `Poseidon(5)`×1 (`leafHash`), `Poseidon(3)`×2
(`nfHash`, `ctxHash`), `GreaterEqThan(64)`×1, `GreaterEqThan(8)`×1, `Num2Bits(64)`×3, `Num2Bits(8)`×2:

| Contribution | Non-linear | % of 6,057 |
|---|---|---|
| `MerkleProof(20)` | 4,920 | 81.26% |
| `Poseidon(3)` × 2 (`nfHash`, `ctxHash`) | 528 | 8.72% |
| `Poseidon(5)` × 1 (`leafHash`) | 324 | 5.35% |
| `Num2Bits(64)` × 3 | 192 | 3.17% |
| `GreaterEqThan(64)` × 1 | 65 | 1.07% |
| `Num2Bits(8)` × 2 | 16 | 0.26% |
| `GreaterEqThan(8)` × 1 | 9 | 0.15% |
| Top-level quadratic glue (`computedValid <== expiryCheck.out * kycCheck.out`, plus the two `x*(1-x)===0` binary-enforcement checks on the comparator outputs) | 3 | 0.05% |
| **Sum** | **6,057** | **100.00%** |

Sum matches `BASELINE.md`'s 6,057 exactly, including the 3-constraint residual — `compliance.circom`
is the one circuit where the top-level logic isn't free: the AND of two comparator outputs is a real
multiplication (1 non-linear constraint) and the two defense-in-depth booleanity checks
(`L7` audit fix) are each a real quadratic constraint. Linear sum: 5,480 + 511 + 2×341 + 4 + 4 + 3×1
+ 2×1 = 6,686, matching `BASELINE.md`'s 6,686 exactly (zero residual).

**`withdraw.circom`** — no Merkle proof (this circuit proves ownership of a single commitment, not
membership in a set). `Poseidon(4)`×3 (`commHash`, `changeHash`, `nfHash`), `Poseidon(2)`×1
(`recipHash`), `Num2Bits(64)`×3, `GreaterThan(64)`×1, `LessEqThan(64)`×1:

| Contribution | Non-linear | % of 1,465 |
|---|---|---|
| `Poseidon(4)` × 3 | 900 | 61.43% |
| `Poseidon(2)` × 1 (`recipHash`) | 243 | 16.59% |
| `Num2Bits(64)` × 3 | 192 | 13.11% |
| `GreaterThan(64)` × 1 | 65 | 4.44% |
| `LessEqThan(64)` × 1 | 65 | 4.44% |
| **Sum** | **1,465** | **100.00%** |

Sum matches `BASELINE.md`'s 1,465 exactly. Here Poseidon really is the dominant cost (78.0%
combined) — `withdraw.circom` is the one circuit `EXPERIMENTS.md` item #2's framing correctly
describes, precisely because it has no Merkle proof to dwarf the domain-tagged hash calls. Linear
sum: 3×436 + 274 + 3×1 + 3 + 4 = 1,592 vs. actual 1,593 — off by 1, attributable to
`remainingBalance <== cumulativeOld - withdrawAmount` (C6's input), the one real arithmetic relation
in this circuit's top level.

### Test suite (full re-run — no production circuit changed, but rebuilt from scratch to confirm nothing broke)

| Suite | Result | Command |
|---|---|---|
| `transfer.circom` (real Groth16) | **43/43 pass** | `node --experimental-vm-modules test/transfer.test.mjs` |
| `compliance.circom` (real Groth16) | **30/30 pass** | `node --experimental-vm-modules test/compliance.test.mjs` |
| `withdraw.circom` (real Groth16) | **35/35 pass** | `node --experimental-vm-modules test/withdraw.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bun run test` |
| Compliance utils (`buildMerkleTree`/`getMerkleProof` at depth 20 with real Poseidon) | **NOT COMPLETED** | `cd scripts && bun run src/test-compliance-utils.ts` — still executing the real-Poseidon depth-20 Merkle verification after several minutes; killed rather than waited out further. Same suite the 2026-07-22 baseline report also did not include in its test table. Not claimed as passing or failing here — genuinely not run to completion. |
| Move contracts | **NOT RUN** | No `sui` CLI available this session either (see On-chain gas, below) — unchanged from 2026-07-22. |

All three circuits were rebuilt from a clean `node_modules`/`build*` state (real Groth16 trusted
setup, not a cached artifact) using the `circom2` toolchain described above, confirming the new
toolchain path produces working, provable circuits end-to-end, not just matching r1cs counts.

No test was loosened, skipped, or given new tolerance.

### On-chain gas per entry point (queue item #1) — attempted first, BLOCKED a third time

Before starting the decomposition above, I spent the first part of this run on queue item #1's
explicit instruction to "spend an early part of the next run purely on unblocking the toolchain."
Result, more conclusive than the previous two attempts:

```
$ curl -sS -m 15 -o /dev/null -w "%{http_code}\n" https://fullnode.testnet.sui.io:443
000  (curl: (56) CONNECT tunnel failed, response 403)

$ curl -sS -m 15 -o /dev/null -w "%{http_code}\n" https://github.com/iden3/circom
403

$ curl -sS -m 15 -o /dev/null -w "%{http_code}\n" https://crates.io
403

$ curl -sS "$HTTPS_PROXY/__agentproxy/status"
"recentRelayFailures": [{
  "ts": "2026-08-06T07:10:50.635Z",
  "kind": "connect_rejected",
  "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
  "host": "fullnode.testnet.sui.io:443"
}]
```

`/root/.ccr/README.md` (this sandbox's own proxy documentation) is explicit: a 403 from the proxy
is an organizational egress-policy denial, not a transient error, and the correct response is
"do not retry or route around it — report the blocked host," not to keep trying variations. That's
a materially different finding than 2026-07-22's (tool-approval-layer denial on one RPC call,
not retried) and 2026-07-14-era's (no CLI, no attempt at a network fallback) — this is now a
**confirmed, repeatable network-policy block on three separate hosts** (the Sui fullnode, GitHub,
and crates.io), not a one-off. `index.crates.io` (bare package metadata) is reachable — the sparse
index is on this sandbox's no-proxy allowlist — but no crate named `circom` exists there to install
even if it were fully reachable.

Still genuinely BLOCKED. Re-ranked in `EXPERIMENTS.md` below with a different recommendation than
before: this needs an infrastructure decision (add `fullnode.testnet.sui.io` to the session's
egress allowlist, or provide a prebuilt `sui` CLI binary in the image) before a fourth attempt is
worth making — repeating the same in-sandbox toolchain search a third time without a policy or
image change is very unlikely to produce a different result.

## Verdict: **KEEP**

`scripts/bench/gadget-constraints.sh` and the eleven `circuits/bench/*.circom` files are a
permanent, reusable addition — any future gadget substitution (Poseidon2, a different Merkle
depth, a wider/narrower range check) gets a real isolated-circuit number from the same harness
before it's proposed for the production circuits. `BASELINE.md` is updated below with the
decomposition table and the 246-constraints/Merkle-level number.

This also functions as a full-suite regression check on the existing protocol: rebuilding all
three circuits from scratch with a different (npm-distributed) circom toolchain and re-running all
108 real-Groth16 circuit tests, the 109 converter tests, and the 19 frontend tests confirms nothing
in the existing protocol depends on the from-source-built compiler specifically.

On-chain gas (queue item #1) stays **BLOCKED**, now with stronger evidence that this is a
network-policy decision rather than a toolchain gap this sandbox can solve on its own.

## Where this could be used

- **Any Circom/Groth16 protocol with a Merkle-membership circuit** (mixers, private-set-membership
  proofs, nullifier accumulators, not just shielded-transfer pools) — the finding that the
  membership proof, not the "business logic" hashes, dominates non-linear constraint count once
  depth exceeds a handful of levels generalizes directly. The 246-constraints/level number is
  Veil-specific (Poseidon(2), BN254), but the *method* — isolate the accumulator template alone,
  compare against `depth × standalone-hash-cost` — is not.
- **A thesis chapter on SNARK circuit optimization methodology**: the reconciliation technique here
  (sum of isolated single-gadget circuits equals the whole circuit's non-linear constraint count,
  modulo real arithmetic relations that aren't pure signal aliases) is a generalizable auditing
  method for any circom circuit — it turns "where do my constraints come from" from a guess into an
  exact, per-line-attributable number, which is exactly the kind of methodology section a
  circuit-optimization thesis chapter needs before its results section.
- **Confidential payroll on Sui with a t-of-n auditor board** (the use case named in the 2026-07-22
  report): if that design uses a similar depth-20+ credential Merkle tree per auditor, this same
  harness tells the designer exactly what raising the tree depth (for a bigger auditor set, or a
  bigger employee anonymity set) costs in prover time before committing to a depth.

## Open questions (next queue)

1. **Poseidon2 at arity 2, isolated and measured** (not yet done): now precisely scoped by tonight's
   numbers — the Merkle hasher (`Poseidon(2)`, called 20×/proof) is worth ~4x more than the
   commitment/nullifier hashers combined in `transfer.circom` and `compliance.circom`. Build
   `circuits/bench/poseidon2_v2.circom` (or whatever the eventual Poseidon2 gadget is named) next,
   measure it with this same harness, and only then decide whether a production swap is worth a
   multi-night circuit-rewrite effort.
2. **On-chain gas** — needs an infrastructure decision (egress allowlist or a prebuilt `sui`
   binary), not another in-sandbox attempt. Flagged explicitly in `EXPERIMENTS.md`.
3. **Merkle depth vs. constraint cost is now linear and known (246/level)** — RR5's anonymity-set
   trade-off (depth 20 → e.g. 26 for a bigger set) can be costed exactly: +6 levels = +1,476
   non-linear constraints, no new measurement needed, just arithmetic on tonight's number.
4. `circuits`' chained `npm test` hang (a lingering `snarkjs`/`ffjavascript` handle, per
   2026-07-22) was already fixed on `main` between nights (PR #17, `f942fca` — explicit
   `process.exit(0)` in all three `circuits/test/*.test.mjs`), unrelated to this experiment.
   `scripts/test-compliance-utils.ts`'s depth-20 real-leaf test, which calls no `snarkjs.groth16`
   at all, ran for several minutes without completing regardless — most likely genuine
   2^20-scale-real-Poseidon-in-pure-JS slowness rather than the same lingering-handle bug. Worth a
   real diagnosis rather than assuming it's covered by PR #17.
