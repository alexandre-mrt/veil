# 2026-09-05 — Poseidon / range-check constraint decomposition (queue item #2, partial)

## Hypothesis

The non-linear constraint count each individual hash and range-check component contributes to
`transfer.circom`, `compliance.circom`, and `withdraw.circom` can be measured in isolation (not
inferred), and summing those isolated costs will account for at least 90% of each circuit's
whole-circuit non-linear constraint total already recorded in `BASELINE.md` — turning "four
Poseidon instances dominate the constraint count" (an `EXPERIMENTS.md` claim) into an exact,
per-component number instead of an aggregate guess. This is the queue's own stated fallback for
item #2 ("re-deriving the exact non-linear-constraint contribution per Poseidon instance from the
current baseline") and directly answers open question #4 from the 2026-07-22 baseline report.

## Threat / privacy model

No adversary model changes. Like the 2026-07-22 baseline night, this is a measurement experiment:
no circuit, Move module, or frontend proving code was modified, so there is no new soundness
argument, leakage analysis, or negative test to write (the "circuit change" requirement doesn't
apply — nothing about what a chain observer, relayer, or malicious prover can do changed).

The relevant framing is the same as the baseline night's: **who relies on this number being
honest.** Every future circuit-optimization experiment in this loop (Poseidon2, a wider Merkle
arity, batching) is a diff against a cost model; if that model attributes cost to the wrong
component, the loop could spend a future night optimizing the wrong 10% of a circuit. Getting the
attribution right, from real isolated compiles rather than eyeballing which templates "look
expensive," is the actual deliverable.

Maps to no STRIDE entry directly (it's not a security change), but the result is directly relevant
to `docs/threat-model.md` RR5 (deposit-commitment linkability / anonymity-set size), since it
identifies the Merkle-path hashing — not the identity-binding hashes — as the dominant cost of the
component whose size (tree depth) sets the anonymity set. Assumptions unchanged from baseline:
Groth16/BN254 soundness, dev-only trusted setup (RR2).

## Approach

**What I built.** `scripts/bench/poseidon-constraint-cost.mjs`, plus seven single-component circom
fixtures under `scripts/bench/fixtures/poseidon-cost/`: `Poseidon(2..5)` (every arity Veil's three
circuits actually instantiate — confirmed by grepping all three `.circom` files and
`templates/merkle_proof.circom` for every `Poseidon(`, `Num2Bits(`, `GreaterThan(`, and
`MerkleProof(` call site), `Num2Bits(64)`, `GreaterThan(64)`, and the full `MerkleProof(20)`
template Veil actually uses for both the transfer-commitment tree and the credential tree (not a
reimplementation — it `include`s the real `templates/merkle_proof.circom`, so it measures the
actual selector/boolean-check overhead around each Poseidon(2) call, not just the bare hash). The
script compiles each fixture as its own `component main`, parses `non-linear constraints` /
`linear constraints` from the compiler's own output, then sums the known call counts per production
circuit and diffs against `BASELINE.md`.

**Toolchain problem hit immediately, and how I solved it.** No `circom` binary was available or
installable this session — `github.com/iden3/circom` (403, network policy) and `static.crates.io`
(403) are both blocked, and no `circom` crate exists on crates.io under that name (`cargo search`
confirms — only unrelated crates like `circom-witness-rs`). This is the same class of block the
2026-07-22 report hit for the `sui` CLI, but this time it blocked the *entire* circuit toolchain,
not just one axis — every circuit-level experiment, including just re-running the existing test
suite, was at risk of being BLOCKED tonight. I found and verified a fix: **`circom2`**, an
npm-distributed WASM build of the same compiler (`registry.npmjs.org` is directly reachable,
unlike GitHub or crates.io's blob storage). Before trusting it for anything, I compiled the
existing `transfer.circom` with it and confirmed byte-for-byte identical output to the committed
baseline (`non-linear constraints: 6470`, `linear constraints: 7141`, `wires: 13632` — exact match,
`circom2 npm package 0.2.23` / `circom compiler 2.2.3`, one patch above the `2.2.2` baseline used
in July). This unblocks every future night's circuit work in this sandbox, not just tonight's
experiment — noted as a queue item below rather than patching `compile*.sh` tonight, to keep this
experiment to one hypothesis.

Powers-of-tau also couldn't be downloaded (`storage.googleapis.com` — 403, same policy). Generated
a fresh `pot15` locally instead (`snarkjs powersoftau new` → `contribute` → `prepare phase2`,
entirely offline, ~5.5 minutes) — this is in fact more honest than downloading a shared file for a
"dev-only, not a production ceremony" setup anyway.

**What I rejected.** I considered actually porting `Poseidon` to `Poseidon2` in
`templates/merkle_proof.circom` and one production circuit to get a *real* swap measurement rather
than a decomposition. Rejected for tonight: Poseidon2's published parameters and reference
round-constant generator (Grain LFSR-based, from the paper's own repo) live on GitHub, which is
blocked this session, and I was not willing to hand-derive or guess BN254 round constants for a
hash function whose collision resistance nullifier-uniqueness and commitment-binding depend on —
an unverified constant set is a soundness bug waiting to happen, not a research result. This is
recorded as its own queue item (below) rather than attempted and BLOCKED, since the fallback
(decomposition) was fully achievable and is explicitly the queue's stated alternative for this
item.

I also considered attributing cost via `circom --O0`/symbol-table introspection instead of
building isolated fixtures. Rejected: isolated single-component compiles are simpler, are exactly
what `BASELINE.md`'s own methodology already does per-circuit, and their sum can be checked against
the real baseline as a correctness test on the method itself (see Results — residuals of 1.0–4.4%
across all three circuits are exactly the sanity check this approach gives for free).

## Results

### Isolated component cost (`node scripts/bench/poseidon-constraint-cost.mjs`)

| Component | Non-linear | Linear |
|---|---|---|
| `Poseidon(2)` | 243 | 274 |
| `Poseidon(3)` | 264 | 341 |
| `Poseidon(4)` | 300 | 436 |
| `Poseidon(5)` | 324 | 511 |
| `Num2Bits(64)` | 64 | 1 |
| `GreaterThan(64)` | 65 | 3 |
| `MerkleProof(20)` (real template: 20× `Poseidon(2)` + 20× `MultiMux1(2)` + 20 boolean checks) | 4,920 | 5,480 |

### Reconciliation against `BASELINE.md`

| Circuit | Components | Attributed non-linear | Baseline non-linear | Attributed % | Residual | Attributed linear | Baseline linear |
|---|---|---|---|---|---|---|---|
| `transfer.circom` | 3×`Poseidon(4)` + 1×`Poseidon(3)` + 1×`MerkleProof(20)` + 4×`Num2Bits(64)` + 1×`GreaterThan(64)` | 6,405 | 6,470 | **99.0%** | 65 | 7,136 | 7,141 |
| `compliance.circom` | 1×`Poseidon(5)` + 2×`Poseidon(3)` + 1×`MerkleProof(20)` + 3×`Num2Bits(64)` | 5,964 | 6,057 | **98.5%** | 93 | 6,676 | 6,686 |
| `withdraw.circom` | 3×`Poseidon(4)` + 1×`Poseidon(2)` + 3×`Num2Bits(64)` + 1×`GreaterThan(64)` | 1,400 | 1,465 | **95.6%** | 65 | 1,588 | 1,593 |

Residuals (35–93 non-linear constraints, ≤4.4% of any circuit's total) are consistent with
comparator/equality-check components (`IsZero`/`IsEqual` on domain tags and nullifier checks) not
individually isolated tonight — small enough that isolating them further would not change any
conclusion below.

Raw command and full output:

```
$ node scripts/bench/poseidon-constraint-cost.mjs
Using circom: circom
  circom2 npm package 0.2.23
  circom compiler 2.2.3

=== Isolated component cost (real circom compile, one component per circuit) ===
component        | non-linear | linear
-----------------|------------|-------
arity2           |        243 | 274
arity3           |        264 | 341
arity4           |        300 | 436
arity5           |        324 | 511
num2bits64       |         64 | 1
greaterthan64    |         65 | 3
merkle20         |       4920 | 5480

=== Reconciliation against docs/research/BASELINE.md ===

transfer.circom  (3xarity4 + 1xarity3 + 1xmerkle20 + 4xnum2bits64 + 1xgreaterthan64)
  hash+range-check non-linear: 6405 / 6470 baseline (99.0%)
  unattributed residual (other comparators/logic): 65
  linear: 7136 attributed vs 7141 baseline

compliance.circom  (1xarity5 + 2xarity3 + 1xmerkle20 + 3xnum2bits64)
  hash+range-check non-linear: 5964 / 6057 baseline (98.5%)
  unattributed residual (other comparators/logic): 93
  linear: 6676 attributed vs 6686 baseline

withdraw.circom  (3xarity4 + 1xarity2 + 3xnum2bits64 + 1xgreaterthan64)
  hash+range-check non-linear: 1400 / 1465 baseline (95.6%)
  unattributed residual (other comparators/logic): 65
  linear: 1588 attributed vs 1593 baseline
```

### The headline finding: the Merkle path, not the identity hashes, dominates

Splitting the two ≥6,000-constraint circuits' Poseidon cost into "Merkle-path Poseidon(2)×20" vs.
"everything else" (identity commitments, nullifiers, domain-tagged amounts):

| Circuit | `MerkleProof(20)` share of total non-linear | Identity/domain Poseidon share | Range-check share |
|---|---|---|---|
| `transfer.circom` | **76.0%** (4,920 / 6,470) | 18.0% (1,164 / 6,470) | 5.0% (321 / 6,470) |
| `compliance.circom` | **81.2%** (4,920 / 6,057) | 14.1% (852 / 6,057) | 3.2% (192 / 6,057) |

`withdraw.circom` has no Merkle proof (it chains directly from a prior commitment), so its
Poseidon cost is 100% identity/domain hashing (78.0% of its total non-linear constraints) — the
contrast confirms the Merkle path specifically, not Poseidon in general, is what dominates the two
larger circuits.

This means `EXPERIMENTS.md`'s existing framing ("four Poseidon instances dominate") was directionally
right but attributed the cost to the wrong instances: swapping the *identity-binding* Poseidon
calls (commitment, nullifier, domain-tagged amount — the ones a Poseidon2 port would most naturally
target first) can move at most ~18% and ~14% of `transfer`'s and `compliance`'s non-linear
constraints respectively. The Merkle-path hashing — 20 sequential arity-2 calls, one per tree level
— is 4–5.7x larger than that and unaffected by a same-arity hash swap; it only shrinks if the tree
gets shallower (smaller anonymity set) or wider (fewer, higher-arity levels).

**A grounded (not measured) illustration of that lever:** a Poseidon(4)-based tree with the same
2^20-commitment capacity needs only 10 levels (4^10 = 2^20) instead of 20. Using tonight's *own*
measured `Poseidon(4)` cost (300 non-linear) as a lower bound — ignoring the necessarily larger
4-way path-selector logic a real `QuaternaryMerkleProof` template would need on top of it — floors
the Merkle-path cost at 10 × 300 = 3,000 non-linear constraints, a ≥39% reduction from the measured
4,920. This is explicitly **UNMEASURED**: no such template exists, its selector overhead is
unknown, and it is not the same experiment as tonight's (which touched no circuit code). It is the
clear next step — queued below, not attempted tonight to keep this experiment to one hypothesis.

**Where a real Poseidon2 port stands:** the published Poseidon2 paper (Grassi, Khovratovich,
Schofnegger, [eprint 2023/323](https://eprint.iacr.org/2023/323.pdf)) reports roughly a 2x
reduction in R1CS constraints over Poseidon at the same security level, from a cheaper external
linear layer rather than fewer rounds. That number is **literature, not a Veil measurement** — no
Poseidon2 circuit was built or compiled tonight (see Approach for why: no verified BN254 round
constants reachable this session without GitHub access). If it holds for Veil's arities, it would
roughly halve the ~18%/~14% identity-hash share above, which is a real but secondary saving next to
the Merkle-arity lever quantified above.

### Existing test suites (re-run in full, unmodified — sanity check that circom2 is a safe substitute)

| Suite | Result | Command |
|---|---|---|
| Circuits (real Groth16 proofs) | **108/108 pass** (43 transfer + 30 compliance + 35 withdraw) — identical to the 2026-07-22 baseline | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bun run test` |
| Move contracts | **NOT RUN** (same blocker as 2026-07-22: no `sui` CLI, and `github.com`/`static.crates.io` are both policy-denied this session too — reconfirmed, not re-attempted beyond one check) | `sui move test` |

No test was loosened, skipped, or given new tolerance. No circuit, Move, or frontend source file was
modified — only new files under `docs/research/` and `scripts/bench/`.

## Verdict: **KEEP**

The decomposition is real, reproducible (`node scripts/bench/poseidon-constraint-cost.mjs`), and
reconciles to 95.6–99.0% of each circuit's measured baseline using only components that already
exist in the codebase. `BASELINE.md` is updated with the new table. It corrects the queue's own
prioritization: the highest-leverage next experiment is Merkle tree arity/depth, not a same-arity
Poseidon2 swap — re-ranked in `EXPERIMENTS.md` accordingly.

The Poseidon2-port and quaternary-Merkle ideas themselves are **PARK**, not attempted: both need
follow-up work (verified round constants; a new, soundness-reviewed template) that didn't fit in
one night alongside the decomposition.

## Where this could be used

- **Any Circom/Groth16 protocol with a UTXO-style Merkle-inclusion circuit** (privacy pools,
  Tornado-Cash-style mixers, zk-rollup account/nullifier trees) — the finding that path depth, not
  the leaf hash function, dominates non-linear constraints applies directly; teams chasing prover
  time should size-check their tree arity before touching the hash primitive.
- **Confidential payroll on Sui with a t-of-n auditor board**: the compliance circuit's credential
  tree uses the identical `MerkleProof(20)` structure measured here. Sizing that tree's depth
  against the actual expected employee count (rather than reusing the transfer tree's depth-20
  default) is a direct, quantifiable cost lever for that deployment.
- **A thesis chapter on circuit-cost attribution methodology**: the technique itself (compile
  single-component fixtures, sum known call counts, diff against a measured whole-circuit
  baseline, treat the residual as a correctness check on the method) generalizes to any R1CS
  circuit optimization, independent of Poseidon or Veil specifically.

## Open questions (next queue)

1. **Build and measure a wider-arity Merkle template** (arity 4 or 8, same leaf capacity) to
   replace tonight's lower-bound projection with a real number — needs a genuine soundness pass on
   the multi-way path selector (more mux constraints than binary `MultiMux1(2)`) and a negative
   test that a malformed multi-way path is rejected, since this would be an actual circuit change.
2. **A real Poseidon2 port for BN254** — blocked tonight on verified round constants (GitHub
   access needed for the reference Grain-LFSR generator, or an already-audited external constant
   set). Worth checking whether a future session's network policy allows it before attempting to
   derive constants by hand.
3. **On-chain gas per entry point** — still `BLOCKED`, reconfirmed tonight before pivoting to this
   experiment: `github.com` (403), `static.crates.io` (403), and a direct
   `suix_queryTransactionBlocks` read against `fullnode.testnet.sui.io` (403) are all denied by
   this session's network policy, not merely absent tooling. Someone with control over the sandbox's
   allowlist may need to add `fullnode.testnet.sui.io` explicitly for this axis to ever close
   without a multi-night from-source Sui build.
4. **Teach `circuits/scripts/compile*.sh` to fall back to `circom2` via npm** when no native
   `circom` binary is on `PATH`, so a future night doesn't have to rediscover tonight's toolchain
   fix from scratch. Low-priority tooling papercut, not attempted tonight to stay in scope.
