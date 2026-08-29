# 2026-08-29 — Poseidon vs Poseidon2: primitive-level constraint/proving-time delta (queue item #2)

## Hypothesis

Swapping Veil's Poseidon calls (circomlib, arities 2/3/4/5) for Poseidon2 (audited circom port,
state widths t ∈ {3,4,8} at those same arities under the capacity-1 fixed-hash convention) reduces
R1CS constraint count and Groth16 proving time, at the exact compiler flags
(`circom ... --r1cs --wasm --sym`, no `--O2`) `circuits/scripts/compile*.sh` actually use to build
`transfer.circom`, `compliance.circom`, and `withdraw.circom` today.

This is queue item #2. It moves "does Poseidon2 help Veil" from a plausible-sounding assumption
(EXPERIMENTS.md: "the highest-leverage next number") to a measured answer — at Veil's specific,
narrow arities, under Veil's specific compiler flags, it does not.

## Threat / privacy model

No adversary model changes: this experiment does not touch `transfer.circom`, `compliance.circom`,
`withdraw.circom`, `templates/merkle_proof.circom`, or any contract — it adds standalone
benchmark-only circuits under `circuits/bench/` that are compiled and measured but never wired into
the protocol. Nothing about what a chain observer, a colluding relayer, a malicious auditor, or a
malicious prover can see or do changes tonight; there is no new deployed artifact, no new trusted
setup for a real circuit, no new nullifier or commitment scheme.

**What relies on this being honest:** the same audience as the 2026-07-22 baseline — this research
loop's own future decisions. A wrong or optimistic number here would send a future night into a
multi-day Poseidon2 migration (new circuits, new trusted setup, new audit, contract redeploy) chasing
a win that doesn't exist for Veil's actual arities. Getting this number right *before* committing to
that lift is the entire point of measuring it as a standalone primitive first.

**What this does NOT establish:**
- Whether Poseidon2 would help at *wider* state (t=8/12/16 used in genuine sponge mode absorbing
  many elements per permutation call, e.g. a redesigned Merkle accumulator) — tonight only tests the
  fixed-hash, one-permutation-call use Veil's circuits actually make.
- Whether `--O2` compilation (which the production circuits do not currently use) is itself safe to
  adopt — see Results and Open questions.
- The correctness of Poseidon2 at t=3 or t=8 to the same bar as t=4 — see Approach for exactly what
  was and wasn't independently cross-checked.

**Assumptions, STRIDE mapping:** unchanged from the existing threat model — Groth16/BN254 soundness,
dev-only trusted setup (RR2, untouched — the benchmark circuits use their own throw-away dev setup,
`circuits/bench/build/*.zkey`, gitignored, never deployed). This experiment maps to no STRIDE entry
directly, same as the 2026-07-22 baseline: it's a prerequisite measurement for a future
Tampering/DoS-adjacent entry ("does a proof-system or primitive change reduce prover cost") that
doesn't exist yet because the answer, for Poseidon2 specifically, turned out to be "not worth
pursuing yet" — see Verdict.

## Approach

**What I built** (all under `circuits/bench/`, none wired into any protocol circuit):

- `poseidon_n2.circom` / `poseidon_n3.circom` / `poseidon_n4.circom` / `poseidon_n5.circom` — bare
  `circomlib` `Poseidon(nInputs)` for the four arities actually used in the codebase (`Poseidon(2)`:
  `templates/merkle_proof.circom`, `withdraw.circom`'s `recipientHash`; `Poseidon(3)`:
  `compliance.circom`'s nullifier/contextId, `transfer.circom`'s `txAmountHash`; `Poseidon(4)`: the
  single most common call — 7 instances across `transfer.circom` and `withdraw.circom`'s
  commitments/nullifiers; `Poseidon(5)`: `compliance.circom`'s credential-leaf hash).
- `poseidon2_t3.circom` / `poseidon2_t4.circom` / `poseidon2_t8.circom` — bare `Poseidon2(t)` from
  `@taceo/circom-lib` (MIT, pinned `^0.9.0`), whose README states the Poseidon2 circuit is "pulled
  from the audited repository for TACEO:OPRF". Poseidon2's defined state widths are
  `{2,3,4,8,12,16}` — there is no t=5 or t=6, so `Poseidon(4)` and `Poseidon(5)` (which need
  capacity-1 widths 5 and 6) have no same-width counterpart and must round up to t=8 for either.
- `poseidon2_check_t4.circom` — a thin wrapper (`Poseidon2Check4`) adding an explicit `claimedOut[4]`
  input signal constrained `=== ` the real permutation output, used only by the negative test (the
  bare `Poseidon2(4)` circuit has no "wrong claimed output" failure mode of its own — its output is
  always derived, never asserted).
- `circuits/scripts/compile-poseidon-bench.sh` — compiles all eight circuits and runs a dev Groth16
  setup for each (`bench/build/`, default `--O1`; `--O2` flag redirects to `bench/build-O2/` for the
  simplification comparison in Results). Downloads its own small `pot12` (2^12, ~4.8MB) rather than
  reusing the production `pot15` — every bench circuit is under 1,700 constraints.
- `scripts/bench/poseidon2-cross-check.mjs` — correctness gate, run *before* any constraint number in
  this report was written down (see below).
- `scripts/bench/poseidon2-negative.mjs` — the negative test.
- `scripts/bench/poseidon2-delta.mjs` — the constraint-count (via the real `snarkjs r1cs info` CLI,
  not a hand-rolled `.r1cs` parser) and proving-time (`snarkjs.groth16.fullProve`, mean of 10 runs
  after one uncounted warm-up, same methodology as `prove-latency.mjs`) comparison.

**Correctness, before citing any number:** Two unrelated, independently-authored BN254 Poseidon2
implementations exist on npm — `@zkpassport/poseidon2` and `@platus-xyz/poseidon2` — and both happen
to only support t=4 (the common "3-input hash" width; neither ships t=3 or t=8). I ran both on the
same input `[1,2,3,4]`, confirmed they agree with each other bit-for-bit, then generated a real
Groth16 proof from `poseidon2_t4.circom` on the same input and confirmed its public output matches
both. This is queue item 3's actual execution, not a claim — `poseidon2-cross-check.mjs` runs all
three and fails loudly if any two disagree.

`@platus-xyz/poseidon2`'s published ESM build ships relative imports missing the required `.js`
extension, which fails strict Node ESM resolution; the cross-check script patches the installed copy
in place (documented inline in the script) rather than silently working around it another way.

**Honest limit of the correctness check:** t=4 is independently verified against two unrelated
implementations. t=3 and t=8 are *not* — no second BN254 implementation on npm supports those widths.
For t=3 and t=8 I'm relying on: `@taceo/circom-lib`'s own claim of pulling from an audited source,
and structural consistency (the same external/internal-round, 4+partial+4 architecture appears
identically across TACEO's, zkpassport's, and platus-xyz's independent implementations — a real but
weaker signal than a bit-for-bit match). Because none of these three circuits are wired into the
protocol, an undetected constant error at t=3 or t=8 would only make tonight's *comparison numbers*
wrong, not create a soundness bug in any deployed circuit — the blast radius of this specific gap is
contained to this experiment.

**What I rejected:** a full swap of `transfer.circom`/`compliance.circom`/`withdraw.circom` to
Poseidon2 — EXPERIMENTS.md item 9 already flags a full proof-system/primitive migration as "a large
lift ... should wait until items 1–2 give a clearer picture," and tonight's own numbers (see Results)
argue against starting that lift at all for these arities. I also rejected hand-deriving Poseidon2
round constants for a native t=5/t=6 (the width Veil would actually want for `Poseidon(4)`/`Poseidon(5)`
without padding to t=8) — inventing untested field-arithmetic constants for a soundness-relevant
primitive is exactly the kind of unverified change this loop's "no estimates presented as
measurements" rule exists to prevent; if this becomes worth pursuing, use whatever width the upstream
audited source actually publishes, not a home-grown derivation.

## Results

### Constraint counts — real production compile flags (`circom ... --r1cs`, no `--O2`)

| Comparison | `Poseidon` constraints | `Poseidon2` constraints | Δ constraints | Δ % |
|---|---|---|---|---|
| `Poseidon(2)` (t=3) vs `Poseidon2(3)` | 517 | 580 | +63 | **+12.2%** |
| `Poseidon(3)` (t=4) vs `Poseidon2(4)` | 605 | 852 | +247 | **+40.8%** |
| `Poseidon(4)` (t=5→8) vs `Poseidon2(8)` | 736 | 1,663 | +927 | **+126.0%** |
| `Poseidon(5)` (t=6→8) vs `Poseidon2(8)` | 835 | 1,663 | +828 | **+99.2%** |

Poseidon2 costs *more* R1CS constraints than circomlib's Poseidon at every arity Veil actually uses,
under the flags Veil actually compiles with. Two separate causes, both real:

1. **Padding to t=8.** `Poseidon(4)` is the single most-used call in the protocol (7 instances across
   `transfer.circom`/`withdraw.circom`) and needs capacity-1 width 5; Poseidon2 has no t=5, so the
   only defined width that fits is t=8 — paying for a permutation over 8 field elements to hash 4.
   This alone explains most of the +126%/+99.2% rows.
2. **Unfused linear layer at `--O1`.** Even at t=3/t=4 (no padding), Poseidon2 still costs more.
   `@taceo/circom-lib`'s `ExternalMatMulT`/`InternalMatMulT`/`Acc` templates each materialize their
   intermediate sums as separate named signals (`signal sum <== ...`, `signal t0 <== ...`, etc.);
   circom's default `--O1` only does signal-to-signal/signal-to-constant simplification, not full
   linear substitution, so each of those becomes its own R1CS row. circomlib's classic `Mix()`
   template instead accumulates the entire matrix-vector product into one `<==` per output element —
   hand-fused by its author, not by the compiler. Confirmed directly: recompiling the same eight
   circuits with `--O2` (full constraint simplification) collapses *all* of this away:

| Comparison (`--O2`) | `Poseidon` constraints | `Poseidon2` constraints | Δ % |
|---|---|---|---|
| `Poseidon(2)` vs `Poseidon2(3)` | 240 | 240 | 0.0% |
| `Poseidon(3)` vs `Poseidon2(4)` | 261 | 264 | +1.1% |
| `Poseidon(4)` vs `Poseidon2(8)` | 297 | 363 | +22.2% |
| `Poseidon(5)` vs `Poseidon2(8)` | 321 | 363 | +13.1% |

Even at full simplification, Poseidon2 doesn't win for Veil's arities — it ties at t=3, and the t=8
padding cost for `Poseidon(4)`/`Poseidon(5)` still shows up (+22.2%/+13.1%). The production circuits
do not compile with `--O2` today (`circuits/scripts/compile*.sh` pass no optimization flag), so the
`--O1` row is the one that actually applies to Veil right now.

### Proving time — Node.js, mean of 10 runs (warm-up run excluded), `--O1` artifacts

| Comparison | `Poseidon` mean (σ) | `Poseidon2` mean (σ) | Δ |
|---|---|---|---|
| n=2 vs t=3 | 132.513 ms (σ 8.215) | 102.212 ms (σ 2.857) | **−22.9%** |
| n=3 vs t=4 | 137.550 ms (σ 5.413) | 106.498 ms (σ 4.347) | **−22.6%** |
| n=4 vs t=8 | 145.116 ms (σ 11.415) | 145.678 ms (σ 5.513) | +0.4% (noise) |
| n=5 vs t=8 | 155.064 ms (σ 10.103) | 151.395 ms (σ 9.350) | −2.4% (mostly noise) |

Proving time does **not** track the constraint-count delta at this scale. Poseidon2 is measurably
*faster* to prove for n=2/n=3 despite having more constraints, and roughly tied for n=4/n=5. At
hundreds of constraints, wall-clock `fullProve` time is dominated by fixed per-call overhead (WASM
instantiation, snarkjs setup) rather than the marginal per-constraint cost — the ~30ms difference
between a 517- and an 852-constraint circuit is smaller than the fixed overhead both pay. This says
nothing about whether the *~13,000-constraint* production circuits would see the same pattern; it
just means tonight's proving-time numbers, standing alone, don't support a "Poseidon2 is faster"
claim for Veil the way the constraint-count numbers argue against it.

### Correctness (queue item 3 execution)

```
$ node scripts/bench/poseidon2-cross-check.mjs
=== Poseidon2(t=4) cross-check: two independent JS libs vs the circom circuit ===

input: [ '1', '2', '3', '4' ]
@zkpassport/poseidon2 : [
  '15505005361706012551741834895355031099510014664842462842053262257331543442865',
  '15540689879131394802373076737172779194862932999849486641952351767738780953784',
  '7917159902307905727813080625122777309809151624119093977983495514817909259553',
  '10305078288915035001787281422329641624507094761680960003698404035062931519465'
]
@platus-xyz/poseidon2 : [ ...same four values... ]
independent JS libs agree: true

@taceo/circom-lib Poseidon2(4) circuit output: [ ...same four values... ]
circuit output matches both independent JS libs: true

PASS — TACEO's Poseidon2(4) circom port is correct for this input, independently verified.
```

### Negative test — malicious witness rejected (queue item 6 execution)

```
$ node scripts/bench/poseidon2-negative.mjs
--- Positive case: correct claimed output ---
ACCEPTED (expected) — proof generated for a correctly-claimed output.

--- Negative case: tampered claimed output (malicious witness) ---
ERROR:  4 Error in template Poseidon2Check4_9 line: 19

REJECTED (expected) — witness calculation failed: Error: Assert Failed. Error in template Poseidon2Check4_9 line: 19

PASS — the constrained wrapper accepts a correct witness and rejects a tampered one.
```

### Raw `circom`/`snarkjs r1cs info` output backing the constraint table

```
$ bash circuits/scripts/compile-poseidon-bench.sh --skip-ptau
=== poseidon_n2 ===
non-linear constraints: 243
linear constraints: 274
[...]
[INFO]  snarkJS: # of Wires: 520
[INFO]  snarkJS: # of Constraints: 517
=== poseidon_n3 ===
[INFO]  snarkJS: # of Wires: 609
[INFO]  snarkJS: # of Constraints: 605
=== poseidon_n4 ===
[INFO]  snarkJS: # of Wires: 741
[INFO]  snarkJS: # of Constraints: 736
=== poseidon_n5 ===
[INFO]  snarkJS: # of Wires: 841
[INFO]  snarkJS: # of Constraints: 835
=== poseidon2_t3 ===
[INFO]  snarkJS: # of Wires: 584
[INFO]  snarkJS: # of Constraints: 580
=== poseidon2_t4 ===
[INFO]  snarkJS: # of Wires: 857
[INFO]  snarkJS: # of Constraints: 852
=== poseidon2_t8 ===
[INFO]  snarkJS: # of Wires: 1672
[INFO]  snarkJS: # of Constraints: 1663

$ bash circuits/scripts/compile-poseidon-bench.sh --O2 --skip-ptau
=== poseidon_n2 (O2) === non-linear constraints: 240, linear constraints: 0
=== poseidon_n3 (O2) === non-linear constraints: 261, linear constraints: 0
=== poseidon_n4 (O2) === non-linear constraints: 297, linear constraints: 0
=== poseidon_n5 (O2) === non-linear constraints: 321, linear constraints: 0
=== poseidon2_t3 (O2) === non-linear constraints: 240, linear constraints: 0
=== poseidon2_t4 (O2) === non-linear constraints: 264, linear constraints: 0
=== poseidon2_t8 (O2) === non-linear constraints: 363, linear constraints: 0
```

Full `poseidon2-delta.mjs` output (constraint counts + all four proving-time comparisons, JSON
summary included) is reproducible with `node scripts/bench/poseidon2-delta.mjs --runs 10` after
`bash circuits/scripts/compile-poseidon-bench.sh`.

### Queue item 1 — on-chain gas (BLOCKED, third attempt, root cause changed)

Spent the early part of tonight's run on this per EXPERIMENTS.md's own note ("worth spending an
early part of the next run purely on unblocking the toolchain"). All three previously-identified and
newly-tried paths are closed, for a *network-policy* reason this time, not a tooling or sandbox
gap:

- `sui` CLI prebuilt binary: `github.com` itself returns `403` through the egress proxy for plain
  HTTPS (`curl https://github.com/...` → `403`); `api.github.com` is scoped to this repository only
  (`alexandre-mrt/veil`) and explicitly refuses `MystenLabs/sui`.
- Direct JSON-RPC to the deployed testnet package: `fullnode.testnet.sui.io:443` is an explicit
  policy denial at the proxy (`gateway answered 403 to CONNECT (policy denial or upstream failure)`,
  confirmed via `curl -sS $HTTPS_PROXY/__agentproxy/status`, `recentRelayFailures`). Per the proxy's
  own README: "do not retry or route around it — report the blocked host." Not retried.
- `cargo install`-able alternative: `crates.io`'s own search shows `sui = "0.0.1"` is a placeholder
  ("This crate is reserved for the Sui project"), not the real CLI — Mysten Labs does not publish it
  to crates.io. `static.crates.io` (the actual `.crate` download host) also returns `403` through this
  proxy, so even a real published crate would fail to download.

This is a genuine organizational network-policy boundary, not a missing tool or a one-off sandbox
denial — re-attempting it a fourth night without a new angle (a different network policy, or explicit
permission to reach one of these hosts) would not change the outcome. Re-ranked to stay at the top of
the queue (it's still the one number several other queued experiments need), but flagged for the
user/operator rather than silently retried again — see Open questions.

## Verdict: **KEEP** (benchmark harness + numbers merged; substantive finding is a soft REJECT of a
Poseidon2 migration for Veil's current arities)

The measurement itself is a clean KEEP: `circuits/bench/`, the compile script, and three new
`scripts/bench/*.mjs` scripts are reusable, cited numbers now exist where before there was only the
EXPERIMENTS.md queue's plausible-sounding assumption. `BASELINE.md` gets a new, clearly-labelled
addendum (not a production number — see below).

The substantive answer the experiment set out to get is a **soft no**: for the specific arities Veil
actually calls (2, 3, 4, 5 field elements, fixed-hash, one permutation call), under the compile flags
Veil actually uses, `@taceo/circom-lib`'s Poseidon2 costs more R1CS constraints than circomlib's
Poseidon — sometimes much more, because Veil's dominant arity (`Poseidon(4)`, 7 call sites) has no
matching Poseidon2 width and must pad to t=8. Proving time doesn't clearly favor either at this small
scale. A full protocol migration to Poseidon2 is not justified by tonight's numbers and should not be
the next thing this loop spends a multi-night circuit-and-trusted-setup effort on.

## Where this could be used

- **Any Circom/Groth16 protocol comparing Poseidon vs Poseidon2 for narrow, fixed-arity hashing**
  (nullifiers, commitments, small Merkle leaves) should measure at *its own* arities before assuming
  Poseidon2 wins — the padding-to-next-defined-width cost (t=5/6 → t=8 here) is arity-dependent and
  can dominate any linear-layer savings. This is a reusable methodology, not just a Veil-specific
  result.
- **A thesis chapter on primitive selection for ZK circuits** gets a concrete counter-example to the
  "Poseidon2 is strictly better" narrative common in its introductory literature: the claimed
  efficiency gain is real for *wide* sponge-mode hashing (many elements absorbed per permutation
  call) and can evaporate or reverse for narrow, single-call fixed hashing — exactly Veil's use case.
- **Compiler-flag auditing for any Circom codebase**: the `--O1` vs `--O2` gap measured here (up to
  247 extra constraints per Poseidon2 call, zero once fully simplified) is a general lesson about how
  much a primitive's benchmarked cost depends on the *author's* manual constraint-fusion discipline
  versus what the compiler will do for you — worth checking before trusting any cross-library
  constraint-count comparison, including this one's `--O1` row.

## Open questions (next queue)

1. **On-chain gas per entry point** stays queue item 1, still BLOCKED — this is now a genuine
   organization-network-policy question (permission to reach `fullnode.testnet.sui.io` or
   `github.com/MystenLabs/sui`), not something more toolchain effort resolves. Worth a direct ask to
   whoever configures this session's egress policy rather than a fourth silent retry.
2. Does Poseidon2 actually win at wide state (t=8/12/16) in genuine multi-element sponge mode — e.g.
   hashing an 8-element Merkle-accumulator batch-insertion payload in one permutation call, vs 2+
   calls of narrow Poseidon? This is the use case Poseidon2's own literature targets and tonight's
   experiment deliberately didn't test it (Veil's circuits only ever do narrow fixed-arity hashing
   today) — directly relevant to queue item 4 (Merkle accumulator at scale) if that experiment ever
   changes the accumulator's per-node hash arity.
3. Is compiling the *production* circuits with `--O2` instead of the current flag-less (`--O1`)
   default safe and worth it on its own, independent of Poseidon2? Tonight's data shows `--O2`
   collapses `transfer.circom`/`compliance.circom`'s current Poseidon calls' linear-constraint bloat
   the same way — a real, much smaller, better-isolated experiment than a primitive swap: re-run
   `circom --O2` on the actual production circuits, diff constraint counts and proving time, confirm
   the existing 108/108 circuit tests still pass unchanged (an `--O2` circuit is logically identical,
   only its R1CS is smaller — but that claim should be measured, not assumed, before any of this
   loop's numbers get re-baselined against `--O2` artifacts).
4. `@platus-xyz/poseidon2`'s published package has a real ESM-resolution bug (missing `.js`
   extensions in relative imports) worked around locally in `poseidon2-cross-check.mjs` — small,
   upstream-reportable, not Veil's problem to fix, noted here only so a future night doesn't
   rediscover it from scratch.
