# 2026-08-14 — Constraint decomposition: what actually costs non-linear constraints (queue item #2)

## Hypothesis

`BASELINE.md` says four Poseidon instances "dominate" `transfer.circom`'s and `compliance.circom`'s
6,470 and 6,057 non-linear constraints, but nobody had broken that down past "Poseidon vs.
`Num2Bits`". This experiment tests a falsifiable, gadget-level claim: **every one of
`transfer.circom`'s, `compliance.circom`'s, and `withdraw.circom`'s non-linear constraints can be
reconstructed, to the constraint, as a sum of isolated single-gadget compilations** (one Poseidon(2)/
(3)/(4)/(5), one `Num2Bits(64)`/`(8)`, one comparator, one Merkle level) times how many times each
circuit instantiates it. If the model is exact, the resulting per-gadget cost table answers the real
question queue item #2 was chasing — which specific structure, not just "Poseidon" as a blob, to
attack first for prover-time — with a number instead of a guess.

Before attempting this, queue item #1 (on-chain gas) was retried first, per `NIGHTLY_PROMPT.md`'s
instruction to spend an early part of the run unblocking it. It is still **BLOCKED**, for two
confirmed, more precise reasons than last time — see Results.

This is a measurement experiment, not a protocol change: no circuit shipped in `circuits/*.circom`
was modified, so the soundness-argument / leakage-analysis / negative-test requirements for a circuit
change do not apply here. The only new artifacts are isolated benchmark circuits under
`scripts/bench/poseidon-gadgets/` that each instantiate one existing, already-audited `circomlib`
template in isolation.

## Threat / privacy model

No adversary model changes — nothing about soundness, privacy, or trust boundaries moved. As with
the 2026-07-22 baseline, the relevant framing is narrower: who relies on this breakdown being honest.

- **This research loop**, on the next Poseidon2/proof-system night: a constraint-count delta claim
  ("Poseidon2 saves X%") is only meaningful if the current cost is attributed to the right gadget.
  If the wrong assumption were guiding it — e.g. treating the Merkle path as "the Poseidon(2)
  instances" and the domain-tag hashes as "the real cost" — a future night could spend effort
  optimizing a permutation for calls that are a minority of the constraint budget while the
  20-level Merkle path (the actual majority — see Results) went untouched.
- **A future decision on Merkle depth** (queue item #4, `docs/threat-model.md` RR5): this gives the
  first real per-level cost of the accumulator, which is the direct input to a depth-vs-anonymity-set
  trade-off analysis.

What this does **not** establish: whether 6,470 constraints is *good* relative to a differently
shaped circuit, whether a Poseidon2 permutation would actually be smaller in R1CS terms (its
external/internal round structure differs enough from Poseidon that isolated-gadget benchmarking
would need a real, verified Poseidon2 circom implementation — not attempted tonight, see Open
Questions), or anything about the dev-only trusted setup (RR2, unchanged). It maps to no new STRIDE
entry; it is a prerequisite for a future entry the same way the 2026-07-22 baseline was.

Assumptions carried over unchanged: Groth16 soundness under BN254 discrete log, dev trusted setup
not production-safe (RR2), and the existing domain-tag scheme (tags 1–8) unmodified.

## Approach

**Retried queue item #1 first (on-chain gas).** Two independent checks, both confirmed-blocked
rather than guessed around:

1. Direct JSON-RPC to a public Sui testnet fullnode: `curl -X POST https://fullnode.testnet.sui.io`
   — the egress proxy's CONNECT tunnel returned `403` (`/root/.ccr/README.md`: "destination host is
   not allowed by your organization's egress policy for this session... do not retry or route
   around it"). Confirmed via the proxy's own status endpoint, which logs the same denial as a
   `recentRelayFailures` entry (`gateway answered 403 to CONNECT`, host
   `fullnode.testnet.sui.io:443`).
2. Fetching a prebuilt `sui` CLI binary or building from source needs the `MystenLabs/sui` GitHub
   repo. `api.github.com` itself is reachable (200), but `GET
   /repos/MystenLabs/sui/releases/latest` returns: *"GitHub access to this repository is not
   enabled for this session... scoped to alexandre-mrt/veil."* — a session-level access-control
   decision, not a network failure, and explicitly not something to route around per this session's
   own repository-scope instructions.

Both are policy denials, not toolchain gaps — no retry, no workaround attempted, per the "don't
retry a 403/407" rule and the "never read/search outside the repo scope" rule. On-chain gas per
entry point remains genuinely unmeasured. Re-flagging this at the top of `EXPERIMENTS.md` won't fix
it a third time on the agent's own authority — see Open Questions for what unblocking it actually
requires (a human decision, not a retry).

**Constraint decomposition.** Built circom 2.2.2 from source (`iden3/circom` tag `v2.2.2`, `cargo
build --release`, ~68s — same recipe as 2026-07-22, reproducible in this sandbox) and ran
`circuits/npm install` (circomlib 2.0.5, snarkjs 0.7.6 — same as baseline). Then:

1. Read every `.circom` file in `circuits/` to get the exact gadget instantiation list per circuit
   (not estimated — `transfer.circom`, `compliance.circom`, `withdraw.circom`,
   `templates/merkle_proof.circom` quoted in full below).
2. Wrote 12 isolated single-instance circuits under `scripts/bench/poseidon-gadgets/`: one component
   each of `Poseidon(2)`, `Poseidon(3)`, `Poseidon(4)`, `Poseidon(5)`, `Num2Bits(64)`, `Num2Bits(8)`,
   `LessEqThan(64)`, `GreaterThan(64)`, `GreaterEqThan(64)`, `GreaterEqThan(8)`, `MultiMux1(2)`, and
   the full `MerkleProof(20)` template (as a cross-check on the additive model, not a gadget itself).
3. Wrote `scripts/bench/poseidon-constraint-decomposition.mjs` — compiles every gadget and all three
   real circuits fresh with the same toolchain, parses circom's own `non-linear constraints:` /
   `linear constraints:` report (not `snarkjs r1cs info`, which only reports the R1CS total and
   doesn't split linear from non-linear), multiplies each gadget's cost by its instantiation count
   per circuit, and prints predicted vs. actual.

**What I rejected.** Actually implementing a Poseidon2 permutation and measuring a real before/after
delta (the literal queue item #2 framing) — rejected for tonight because Poseidon2's round structure
(reduced full rounds + an internal-round matrix distinct from Poseidon's) isn't something to
hand-derive round constants and a matrix for without a verified reference implementation to check
against; doing that from memory risks shipping a broken or insecure hash disguised as a benchmark,
which is a worse outcome than not measuring it. The queue's own alternate framing — "re-deriving the
exact non-linear-constraint contribution per Poseidon instance from the current baseline" — is both
safer (touches no cryptography, only measures existing audited gadgets) and, as it turned out, more
informative than a two-point Poseidon-vs-Poseidon2 comparison would have been (see Results: it
locates the cost in the Merkle path, not primarily in the domain-tag hashes the "four Poseidon
instances" framing implied).

## Results

### Isolated gadget costs (raw `circom` compiler output, ANSI-stripped)

| Gadget | Non-linear | Linear | Instances compiled |
|---|---|---|---|
| `Poseidon(2)` | 243 | 274 | 72 |
| `Poseidon(3)` | 264 | 341 | 71 |
| `Poseidon(4)` | 300 | 436 | 75 |
| `Poseidon(5)` | 324 | 511 | 75 |
| `Num2Bits(64)` | 64 | 1 | 2 |
| `Num2Bits(8)` | 8 | 1 | 2 |
| `LessEqThan(64)` | 65 | 4 | 4 |
| `GreaterThan(64)` | 65 | 3 | 4 |
| `GreaterEqThan(64)` | 65 | 4 | 4 |
| `GreaterEqThan(8)` | 9 | 4 | 4 |
| `MultiMux1(2)` | 2 | 0 | 2 |
| `MerkleProof(20)` (whole template, cross-check) | 4,920 | 5,480 | 74 |

Raw command output (`node scripts/bench/poseidon-constraint-decomposition.mjs`, full run below in
"Full raw output"):

```
poseidon2            non-linear=  243  linear=  274  templates=72
poseidon3            non-linear=  264  linear=  341  templates=71
poseidon4             non-linear=  300  linear=  436  templates=75
poseidon5            non-linear=  324  linear=  511  templates=75
num2bits64           non-linear=   64  linear=    1  templates=2
num2bits8            non-linear=    8  linear=    1  templates=2
lesseqthan64         non-linear=   65  linear=    4  templates=4
greaterthan64        non-linear=   65  linear=    3  templates=4
greaterequalthan64   non-linear=   65  linear=    4  templates=4
greaterequalthan8    non-linear=    9  linear=    4  templates=4
multimux1_2          non-linear=    2  linear=    0  templates=2
merkleproof20        non-linear= 4920  linear= 5480  templates=74
```

**Cross-check:** `MerkleProof(20)` should equal 20×`Poseidon(2)` + 20×`MultiMux1(2)` + 20 boolean
constraints (`pathIndices[i]*(1-pathIndices[i])===0`, `merkle_proof.circom:19`, one per level, itself
non-linear since it's a signal product):

```
MerkleProof(20) cross-check: predicted non-linear=4920 actual=4920 (delta 0)
MerkleProof(20) cross-check: predicted linear=5480 actual=5480 (delta 0)
```

Exact match. Each Merkle level costs **246 non-linear constraints** (243 for the level's `Poseidon(2)`
+ 2 for its `MultiMux1(2)` left/right selector + 1 for the boolean check) and 274 linear.

### Predicted (sum of gadgets) vs. actual, fresh-compiled real circuits

| Circuit | Predicted non-linear | Actual non-linear | Δ non-linear | Predicted linear | Actual linear | Δ linear |
|---|---|---|---|---|---|---|
| `transfer.circom` | 6,470 | 6,470 | **0** | 7,148 | 7,141 | −7 |
| `compliance.circom` | 6,057 | 6,057 | **0** | 6,690 | 6,686 | −4 |
| `withdraw.circom` | 1,465 | 1,465 | **0** | 1,597 | 1,593 | −4 |

Non-linear constraints reconstruct **exactly**, to the constraint, for all three circuits — the
additive gadget model is not an approximation, it's the real structure. The small linear-constraint
gap (which top-level `===` equality checks, e.g. `merkleRoot === membershipProof.root`, were assumed
to cost 1 linear constraint each) is fully explained: circom's default optimizer (`O1`) eliminates
simple linear-equality constraints by substitution before emitting R1CS, but never touches non-linear
ones — a multiplication gate can't be substituted away. This matters for the report's own
methodology (linear-constraint counts from isolated gadgets slightly overstate a circuit's actual
linear total once wired into a bigger circuit) but not for the conclusion below, since Groth16
prover time scales with non-linear (R1CS) constraint count, and that number is exact.

### Where the non-linear budget actually goes

| Circuit | Merkle accumulator (depth 20) | Domain-tag Poseidon hashes | Range checks / comparators | Total |
|---|---|---|---|---|
| `transfer.circom` | 4,920 (**76.0%**) | 1,164 (18.0%) — 3×`Poseidon(4)` + 1×`Poseidon(3)` | 386 (6.0%) — 4×`Num2Bits(64)` + `GreaterThan(64)` + `LessEqThan(64)` | 6,470 |
| `compliance.circom` | 4,920 (**81.2%**) | 852 (14.1%) — `Poseidon(5)` + 2×`Poseidon(3)` | 285 (4.7%) — 3×`Num2Bits(64)` + 2×`Num2Bits(8)` + 2 comparators + 3 extra (1 multiplication, 2 boolean checks) | 6,057 |
| `withdraw.circom` (no Merkle tree) | — | 1,143 (78.0%) — 3×`Poseidon(4)` + 1×`Poseidon(2)` | 322 (22.0%) — 3×`Num2Bits(64)` + `GreaterThan(64)` + `LessEqThan(64)` | 1,465 |

This is the actual finding, and it's a correction to the framing in `BASELINE.md`/`EXPERIMENTS.md`:
**Poseidon overall is ~93–94% of `transfer.circom`'s and `compliance.circom`'s non-linear
constraints, but three-quarters to four-fifths of that is the depth-20 Merkle authentication path —
not the "four Poseidon instances" (commitment/nullifier/txAmountHash) the existing docs call out.**
`withdraw.circom` has no Merkle tree and its domain-tag hashes alone are 78% of its (much smaller)
budget — consistent with the same per-hash cost, just without a 4,920-constraint tree on top.

### Full raw output

```
=== Compiling isolated gadgets ===

poseidon2            non-linear=  243  linear=  274  templates=72
poseidon3            non-linear=  264  linear=  341  templates=71
poseidon4            non-linear=  300  linear=  436  templates=75
poseidon5            non-linear=  324  linear=  511  templates=75
num2bits64           non-linear=   64  linear=    1  templates=2
num2bits8            non-linear=    8  linear=    1  templates=2
lesseqthan64         non-linear=   65  linear=    4  templates=4
greaterthan64        non-linear=   65  linear=    3  templates=4
greaterequalthan64   non-linear=   65  linear=    4  templates=4
greaterequalthan8    non-linear=    9  linear=    4  templates=4
multimux1_2          non-linear=    2  linear=    0  templates=2
merkleproof20        non-linear= 4920  linear= 5480  templates=74

MerkleProof(20) cross-check: predicted non-linear=4920 actual=4920 (delta 0)
MerkleProof(20) cross-check: predicted linear=5480 actual=5480 (delta 0)

=== Compiling real circuits (fresh, same toolchain) ===

transfer     non-linear=6470  linear=7141
compliance   non-linear=6057  linear=6686
withdraw     non-linear=1465  linear=1593

=== Predicted (sum of isolated gadgets) vs. actual ===

circuit     gadget              count  nonlin/ea  nonlin-sub  lin/ea  lin-sub
transfer    merkleproof20       1      4920       4920        5480    5480
transfer    poseidon4           3      300        900         436     1308
transfer    poseidon3           1      264        264         341     341
transfer    greaterthan64       1      65         65          3       3
transfer    num2bits64          4      64         256         1       4
transfer    lesseqthan64        1      65         65          4       4
transfer    +extra                                0                   8
  -> predicted: non-linear=6470 linear=7148   actual: non-linear=6470 linear=7141   delta: non-linear=0 linear=-7

compliance  poseidon5           1      324        324         511     511
compliance  merkleproof20       1      4920       4920        5480    5480
compliance  poseidon3           2      264        528         341     682
compliance  greaterequalthan64  1      65         65          4       4
compliance  greaterequalthan8   1      9          9           4       4
compliance  num2bits64          3      64         192         1       3
compliance  num2bits8           2      8          16          1       2
compliance  +extra                                3                   4
  -> predicted: non-linear=6057 linear=6690   actual: non-linear=6057 linear=6686   delta: non-linear=0 linear=-4

withdraw    poseidon4           3      300        900         436     1308
withdraw    poseidon2           1      243        243         274     274
withdraw    num2bits64          3      64         192         1       3
withdraw    greaterthan64       1      65         65          3       3
withdraw    lesseqthan64        1      65         65          4       4
withdraw    +extra                                0                   5
  -> predicted: non-linear=1465 linear=1597   actual: non-linear=1465 linear=1593   delta: non-linear=0 linear=-5

=== Poseidon share of non-linear constraints ===

transfer     Poseidon non-linear=6024  of total=6470  (93.1%)
compliance   Poseidon non-linear=5712  of total=6057  (94.3%)
withdraw     Poseidon non-linear=1143  of total=1465  (78.0%)
```

(The last block's "Poseidon non-linear" figure counts only the `Poseidon` permutation calls
themselves — 4,860 of the Merkle tree's 4,920 plus the domain-tag hashes — not the tree's `MultiMux1`
selector or boolean-check scaffolding. The 76.0%/81.2% figures in the table above count the *whole*
Merkle accumulator, scaffolding included, since that's the unit that actually changes if the tree
depth changes.)

Reproduce: `CIRCOM_BIN=/path/to/circom node scripts/bench/poseidon-constraint-decomposition.mjs`
(builds circom per `circuits/scripts/compile.sh` if not already on `PATH`).

### Test suite

No circuit, contract, or frontend code changed — only new isolated benchmark circuits and a new
script were added. Ran every suite the repo has, per `NIGHTLY_PROMPT.md`'s requirement to run the
full suite before opening the PR (fresh compile of all three circuits with a real dev Groth16 setup,
same toolchain as this experiment):

| Suite | Result | Command |
|---|---|---|
| `transfer.circom` (real Groth16) | **43/43 pass** | `cd circuits && node --experimental-vm-modules test/transfer.test.mjs` |
| `compliance.circom` (real Groth16) | **30/30 pass** | `node --experimental-vm-modules test/compliance.test.mjs` |
| `withdraw.circom` (real Groth16) | **35/35 pass** | `node --experimental-vm-modules test/withdraw.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils (credential leaf, Merkle builder) | **67/67 pass** | `bun run src/test-compliance-utils.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Property-based fuzz (fast-check) | **6/6 properties pass** (500 runs each) | `cd scripts && bun run src/fuzz-tests.ts` |
| Move contracts (124 tests) | **NOT RUN** | `sui` CLI still unavailable — same blocker as 2026-07-22, reconfirmed this session (see Results) |

That's 309/309 automated tests passing across every suite this sandbox can run. No test was loosened,
skipped, or given new tolerance to reach these numbers.

Raw output, `compliance-utils`' depth-20 Merkle-build test genuinely takes ~1–2 minutes (real Poseidon
hashing of a 2^20-leaf tree in JS, not a hang — confirmed by letting it run to completion in the
background rather than assuming the same lingering-process symptom noted in the 2026-07-22 report):

```
$ cd circuits && node --experimental-vm-modules test/transfer.test.mjs
=== Results: 43 passed, 0 failed ===

$ node --experimental-vm-modules test/compliance.test.mjs
=== Results: 30 passed, 0 failed ===

$ node --experimental-vm-modules test/withdraw.test.mjs
=== Results: 35 passed, 0 failed ===

$ cd ../scripts && bun run src/test-converter.ts
Results: 109 passed, 0 failed
All tests passed.

$ bun run src/test-compliance-utils.ts
Results: 67 passed, 0 failed
All tests passed.

$ cd ../frontend && bunx vitest run
 Test Files  3 passed (3)
      Tests  19 passed (19)

$ cd ../scripts && bun run src/fuzz-tests.ts
P1: Commitment determinism         PASSED (500 runs, 195ms)
P2: Nullifier uniqueness            PASSED (500 runs, 184ms)
P3: Cumulative addition no wrap     PASSED (500 runs, 2ms)
P4: Merkle proof soundness          PASSED (500 runs, 2039ms)
P5: Domain separation no collision  PASSED (500 runs, 145ms)
P6: Credential validity logic       PASSED (500 runs, 2ms)
ALL 6 PROPERTIES PASSED
```

## Verdict: **KEEP**

The additive gadget model reconstructs every non-linear constraint in all three circuits exactly —
this is now a reusable, verified tool (`scripts/bench/poseidon-constraint-decomposition.mjs`) for any
future circuit-cost question, not a one-off number. `BASELINE.md` is updated with the per-gadget
breakdown table. The headline correction — Merkle path >> domain-tag hashes as a share of constraint
cost — changes what queue item #2 (now item #9, re-ranked below) should actually measure next.

On-chain gas (queue item #1) remains **BLOCKED**, confirmed for two independent, non-retryable
reasons this time (proxy policy 403 on the public fullnode; GitHub access scoped to this repo only).
It stays at the top of the queue, annotated with what unblocking it actually needs — see Open
Questions.

## Where this could be used

- **Any Circom/Groth16 shielded-pool circuit with a Merkle-membership gadget** (Tornado-Cash-style
  mixers, most privacy rollups' deposit trees): before spending effort on hash-function choice, this
  says to check tree depth's share of the constraint budget first — it was 3–4x the domain-tag
  hashing cost here, and would only grow at greater depth (each level costs a fixed, now-known 246
  non-linear constraints regardless of what the leaf hash function is).
- **A thesis chapter's cost model for accumulator depth vs. anonymity-set size**: this gives the
  first real, verified marginal cost per tree level (246 non-linear / 274 linear constraints), which
  turns "how much would a bigger anonymity set cost in prover time" from a guess into
  `base_cost + depth × 246` — worth confirming with one more real depth-24/28 compile next, but the
  functional form is now measured, not assumed.
- **Any protocol deciding whether a proof-system or hash-function migration is worth a multi-night
  effort** (Veil's own queued Poseidon2/PLONK/Halo2 items): this is the due-diligence step that
  should run before committing — it would have been easy to spend a night porting Poseidon2 and find
  the win was smaller than expected because 76–81% of the target circuits' cost is tree traversal,
  not the domain-tag hash calls that motivated the effort.

## Open questions (next queue)

1. **On-chain gas per entry point (queue item #1, still top).** Confirmed blocked for two reasons
   this run, neither retryable by the agent: the egress proxy denies the public Sui fullnode RPC
   host by organization policy, and this session's GitHub access is scoped to
   `alexandre-mrt/veil` only, so `MystenLabs/sui` releases/source are unreachable regardless of
   network policy. Unblocking this needs a **human** decision — either widen this session's repo
   scope to include `MystenLabs/sui` (to build the `sui` CLI from source) or add
   `fullnode.testnet.sui.io` to the egress allowlist (to read gas costs via JSON-RPC directly) —
   not another automated retry attempt.
2. **Merkle depth vs. proving time, with a real recompile.** This experiment predicts (not measures)
   that `transfer.circom` at depth 24 would cost `6,470 - 4,920 + 24×246 = 7,454` non-linear
   constraints. A cheap next-night task: actually recompile `MerkleProof(24)` and `MerkleProof(28)`
   in isolation (the gadget harness already exists) and confirm the linear model holds outside the
   depth-20 case it was fit to.
3. **Poseidon2, now scoped correctly.** Given the Merkle path is 76–81% of the relevant circuits'
   cost and it's built entirely from `Poseidon(2)` calls, a future Poseidon2 experiment should
   benchmark an isolated, reference-verified Poseidon2(2) permutation's constraint count first — that
   single number, times 20, predicts almost the entire achievable saving before touching
   `transfer.circom` or `compliance.circom` at all. Needs a trustworthy Poseidon2 circom
   implementation to compile against (not attempted tonight — see Approach for why).
4. **`Num2Bits`/comparator share (6.0%/4.7%/22.0%)** is real but small relative to the Merkle path in
   two of three circuits — deprioritize range-check optimization relative to items 2–3 above unless
   `withdraw.circom` specifically (22%, no Merkle tree to dominate it) becomes the target.
5. Linear-constraint optimizer slack (predicted vs. actual deltas of −7/−4/−4): confirms circom's
   `O1` pass substitutes away simple linear-equality constraints but never non-linear ones. Doesn't
   change any conclusion here (non-linear drives Groth16 prover time) but worth a one-line note if a
   future report cites linear-constraint counts from isolated gadgets as circuit-accurate — they
   aren't, once wired into a larger circuit.
