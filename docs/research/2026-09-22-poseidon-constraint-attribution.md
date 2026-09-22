# 2026-09-22 — Poseidon constraint attribution (queue item #2, fallback path)

## Hypothesis

The exact non-linear-constraint contribution of every gadget in `transfer.circom`,
`compliance.circom`, and `withdraw.circom` — each Poseidon instance, each `Num2Bits(64)` range
check, each comparator, the Merkle-path mux — can be measured in isolation and summed back to each
circuit's whole-circuit constraint count from `docs/research/BASELINE.md` to within a handful of
constraints, turning "Poseidon dominates the constraint count" (README.md's claim) from an
impression into an exact, reproducible number per circuit.

This is queue item #2's explicitly-named fallback ("re-deriving the exact non-linear-constraint
contribution per Poseidon instance from the current baseline"), not a Poseidon2 swap — see
**Approach** for why the swap itself was rejected tonight.

## Threat / privacy model

**No production circuit was touched.** `transfer.circom`, `compliance.circom`, and
`withdraw.circom` are byte-for-byte unchanged. This experiment adds isolated, single-gadget
circuits under `circuits/bench-primitives/` (each one `component main = Poseidon(4);` or
equivalent) that are compiled for their constraint count only — never given a trusted setup, never
wired into `contracts/`, never touched by `frontend/`. They cannot be proven against or verified
on-chain; they exist purely as `circom --r1cs` inputs.

Because of that, the usual per-experiment sections don't apply in their normal form:

- **Adversary this defends against**: none — nothing is being defended, nothing changed for an
  adversary to attack. The "adversary" for this experiment is the same one named in the 2026-07-22
  baseline report: a future engineer (including a future run of this loop) who trusts a wrong
  number. If the Poseidon share of `transfer.circom`'s constraints were mis-measured as, say, 60%
  instead of the real 93.1%, a future Poseidon2 migration would be greenlit or shelved on a false
  premise.
- **What this does NOT defend against**: it says nothing about circuit soundness, on-chain gas, or
  privacy — those threat surfaces are exactly as documented in `docs/threat-model.md` before
  tonight. It does not itself close RR2 (trusted setup) or RR5 (deposit-commitment linkability).
- **Assumptions**: none beyond what `BASELINE.md` already assumes (BN254, circom 2.2.2's constraint
  generation being deterministic given fixed source — which tonight's exact reconciliation to zero
  residual on the non-linear count is itself evidence for).
- **STRIDE mapping**: none. This is instrumentation, not a security control.

Since no circuit, Move module, or on-chain-facing code changed, the "soundness argument / leakage
analysis / negative test" requirement for circuit changes does not apply — there is no new
constraint, no new public input, and no new witness path for a malicious prover to exploit.

## Approach

**What I built:**

- `circuits/bench-primitives/*.circom` — twelve single-gadget circuits: `Poseidon(2)` through
  `Poseidon(5)`, `Num2Bits(8)`/`Num2Bits(64)`, `GreaterThan(64)`, `GreaterEqThan(64)`,
  `GreaterEqThan(8)`, `LessEqThan(64)`, `MultiMux1(2)`, and `MerkleProof(1)` / `MerkleProof(20)`
  (the last two to directly verify that Merkle-path cost scales exactly linearly with depth, rather
  than assuming it).
- `circuits/scripts/bench-primitives.sh` — compiles each fixture with `circom --r1cs`, parses the
  compiler's own non-linear/linear/wires breakdown from stdout (not `snarkjs r1cs info`, which in
  this toolchain's version only reports the combined total — see Results), and writes
  `circuits/build-bench-primitives/results.tsv`.
- `scripts/bench/poseidon-attribution.mjs` — reads that TSV, recompiles the three real circuits
  fresh (constraint count only, no ptau needed), reconstructs each circuit's non-linear and linear
  totals as a named sum of gadget instantiations, and **asserts** the residual is zero (non-linear)
  or ≤2 (linear) — it exits non-zero if a future circuit edit breaks the reconciliation, so this
  becomes a live regression check, not a one-off measurement that silently goes stale.

**What I rejected:** an actual Poseidon2 swap, which is what queue item #2 originally asked for.
I looked for a maintained circom implementation of Poseidon2 (searched npm — nothing under
`circom-poseidon2`, `poseidon2-circom`; `circomlib` itself is at 2.0.5 with no Poseidon2 template;
the only Poseidon2 npm packages found, `poseidon2` and `@zkpassport/poseidon2`, are plain-TypeScript
or Noir implementations, not circom). Writing a from-scratch circom Poseidon2 permutation means
generating my own round constants and MDS/internal-matrix parameters — the Poseidon2 paper's
security argument depends on those being generated correctly by the reference script, and I have no
way to cross-check a self-derived set against a trusted source tonight without that reference
implementation. Shipping a hash-function primitive with self-generated round constants and no way
to verify them against the paper's reference is exactly the kind of unverifiable "measurement" the
one rule of this loop forbids by extension — a broken or weak-in-a-way-I-can't-detect Poseidon2
would be a soundness regression disguised as an optimization. So: measure the ceiling first,
attempt the swap on a future night with either a vetted reference implementation or a budget to
verify one from the paper by hand.

**Toolchain note:** `circom` was not on `PATH` in this fresh session (matches the pattern from
2026-07-22 — the container does not persist installed binaries between nights). Rebuilt it the same
way: `git clone --depth 1 --branch v2.2.2 https://github.com/iden3/circom`, `cargo build --release`,
installed to `/usr/local/bin/circom`. Unlike 2026-07-22, this succeeded without any sandbox
denial — the earlier report's "`cp` to `/root/.cargo/bin` was denied" issue did not recur when
copying to `/usr/local/bin` instead.

## Results

### Primitive constraint costs (raw `circom --r1cs` output, parsed by `bench-primitives.sh`)

```
$ bash circuits/scripts/bench-primitives.sh
gadget                       r1cs     nonlin     linear    wires
------                       ----     ------     ------    -----
greaterequalthan64             69         65          4       71
greaterequalthan8              13          9          4       15
greaterthan64                  68         65          3       70
lessequalthan64                69         65          4       71
merkleproof1                  520        246        274      523
merkleproof20               10400       4920       5480    10422
multimux1x2                     2          2          0        8
num2bits64                     65         64          1       66
num2bits8                       9          8          1       10
poseidon2                     517        243        274      520
poseidon3                     605        264        341      609
poseidon4                     736        300        436      741
poseidon5                     835        324        511      841
```

`merkleproof20` is exactly `20 × merkleproof1` on every column (10,400 = 20×520, 4,920 = 20×246,
5,480 = 20×274) — Merkle-path cost scales perfectly linearly with depth in this construction, with
no fixed per-tree overhead. That is itself a useful, previously-unconfirmed number for queue item
#4 (Merkle accumulator scaling): going from depth 20 to, say, depth 32 costs exactly
`12 × 520 = 6,240` more constraints, not a guess.

### Reconciliation against the three production circuits (`node scripts/bench/poseidon-attribution.mjs`)

```
=== transfer.circom ===
  whole-circuit (circom --r1cs, this run): non-linear 6470, linear 7141
  Merkle path (depth 20): 20x Poseidon(2)                      non-linear   4860  linear   5480
  Merkle path (depth 20): 20x MultiMux1(2) + binary check      non-linear     60  linear      0
  oldCommitment, newCommitment, nullifier: 3x Poseidon(4)      non-linear    900  linear   1308
  txAmountHash: 1x Poseidon(3)                                 non-linear    264  linear    341
  Range checks: 4x Num2Bits(64)                                non-linear    256  linear      4
  Comparators: GreaterThan(64) + LessEqThan(64)                non-linear    130  linear      7
  sum of named parts:                                          non-linear 6470  linear 7140
  residual (top-level assertions not in any gadget):          non-linear 0  linear 1
  Poseidon share of non-linear constraints: 6024/6470 = 93.1%

=== compliance.circom ===
  whole-circuit (circom --r1cs, this run): non-linear 6057, linear 6686
  Credential leaf: 1x Poseidon(5)                              non-linear    324  linear    511
  Merkle path (depth 20): 20x Poseidon(2)                      non-linear   4860  linear   5480
  Merkle path (depth 20): 20x MultiMux1(2) + binary check      non-linear     60  linear      0
  Nullifier + context binding: 2x Poseidon(3)                  non-linear    528  linear    682
  Expiry/KYC comparators: GreaterEqThan(64) + GreaterEqThan(8) non-linear     74  linear      8
  Defense-in-depth binary checks + AND gate (3x quadratic)     non-linear      3  linear      0
  Range checks: 2x Num2Bits(64) + 2x Num2Bits(8) + 1x Num2Bits(64) non-linear    208  linear      5
  sum of named parts:                                          non-linear 6057  linear 6686
  residual (top-level assertions not in any gadget):          non-linear 0  linear 0
  Poseidon share of non-linear constraints: 5712/6057 = 94.3%

=== withdraw.circom ===
  whole-circuit (circom --r1cs, this run): non-linear 1465, linear 1593
  commitment + change commitment + nullifier: 3x Poseidon(4)   non-linear    900  linear   1308
  recipientHash: 1x Poseidon(2)                                non-linear    243  linear    274
  Range checks: 3x Num2Bits(64)                                non-linear    192  linear      3
  Comparators: GreaterThan(64) + LessEqThan(64)                non-linear    130  linear      7
  sum of named parts:                                          non-linear 1465  linear 1592
  residual (top-level assertions not in any gadget):          non-linear 0  linear 1
  Poseidon share of non-linear constraints: 1143/1465 = 78.0%

All three circuits reconciled within tolerance (non-linear exact, linear residual <= 2).
```

Every non-linear constraint in all three circuits is accounted for exactly (residual 0). The
1-constraint linear residuals in `transfer.circom` and `withdraw.circom` are the single top-level
`===` assertion each circuit makes outside any gadget (`cumulativeNew === cumulativeOld + txAmount`
in transfer; the implicit signal-declaration cost of `remainingBalance` in withdraw) — not
measurement noise, a fully explained gap.

| Circuit | Total non-linear | Poseidon non-linear | Poseidon share |
|---|---|---|---|
| `transfer.circom` | 6,470 | 6,024 | **93.1%** |
| `compliance.circom` | 6,057 | 5,712 | **94.3%** |
| `withdraw.circom` | 1,465 | 1,143 | **78.0%** |

`withdraw.circom`'s lower Poseidon share (78.0% vs. ~93-94%) is explained by its lack of a Merkle
membership proof — the one gadget class (`Poseidon(2)` × depth) that dominates the other two
circuits' constraint budgets.

### Test suite

Full suite run tonight (fresh `circom`/`snarkjs`/ptau, same dev-only local trusted setup pattern as
`circuits/scripts/compile*.sh` — no production circuit touched, so these numbers are a
reproducibility check, not new coverage):

| Suite | Result | Command |
|---|---|---|
| Circuits (real Groth16 proofs) | **108/108 pass** (43 transfer + 30 compliance + 35 withdraw) | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Property-based fuzz | **6/6 properties, 500 cases each** | `cd scripts && bun run src/fuzz-tests.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Move contracts | **NOT RUN** — `sui` CLI unavailable (see Approach / queue item #1) | `cd contracts && sui move test` |

No test was loosened, skipped, or given new tolerance. This experiment's own correctness check
(`poseidon-attribution.mjs`'s reconciliation assertion) is itself a new, permanent regression test:
it fails loudly if a future circuit edit changes constraint counts without this document being
updated to match.

## Verdict: **KEEP**

The attribution is exact (0 non-linear residual, ≤1 linear residual, all three circuits) and
reproducible with two short scripts, neither of which touches a production circuit. `BASELINE.md`
gets a new "Constraint attribution" section with this table, so the next Poseidon2 (or any other
hash-primitive swap) attempt starts from a known ceiling instead of a guess: **at most 93-94% of
`transfer.circom`/`compliance.circom`'s non-linear constraints, and 78% of `withdraw.circom`'s, are
addressable by changing the hash function** — everything else (range checks, comparators, Merkle
muxing) is untouched by that class of optimization and would need separate work (e.g., tighter
range checks, or eliminating a redundant `Num2Bits` call) to move further.

## Where this could be used

- **Any Circom/Groth16 (or any R1CS-based) circuit doing hash-heavy work** — commitment schemes,
  Merkle accumulators, nullifier derivation — benefits from this same isolate-and-reconcile method
  before committing to a hash-primitive swap. It turns "hashing dominates the circuit" from folklore
  into a per-circuit, per-gadget number that can be checked into a regression test.
- **A thesis chapter arguing for or against a Poseidon2 migration** in any BN254/Groth16 system
  needs exactly this ceiling number as its opening argument — "at most X% of the constraint budget
  is reachable by this change" is the sentence every such chapter needs and usually skips.
  Confidential payroll or compliance-gated DeFi circuits shaped like Veil's (credential Merkle
  membership + threshold checks, `compliance.circom` here) sit at the high end of that ceiling
  (94.3%), making them the best-case target for a future Poseidon2 or Poseidon-optimized-round-count
  swap.
- **Merkle accumulator depth planning** (queue item #4): the confirmed-linear per-level cost (520
  constraints/level, exactly) means the constraint-count cost of any depth choice — and therefore
  its proving-time cost, given the baseline's near-linear constraint-to-time correlation — is now a
  closed-form calculation, not a re-measurement, for every future accumulator-sizing decision.

## Open questions (next queue)

1. **A vetted Poseidon2 circom implementation** is still queue item #2's real ask and is now
   better-scoped: with the 93-94% ceiling established, the payoff calculation is "how much of that
   93-94% does Poseidon2 actually save" — worth pursuing once a reference implementation (round
   constants + matrices from the paper's own generation script, not self-derived) is available to
   cross-check against, or a full night is budgeted to derive and verify one by hand.
2. **Range-check tightening** (the 4.0%/3.4%/13.1% of transfer/compliance/withdraw's non-linear
   constraints that are `Num2Bits(64)` calls): several of these check values that are already
   bounded elsewhere in the protocol (e.g., token amounts bounded by Sui's own `u64`) — worth an
   audit of which `Num2Bits(64)` calls are structurally redundant before touching Poseidon at all,
   since this class of change carries none of Poseidon2's round-constant risk.
3. **On-chain gas per entry point** (queue item #1, unchanged rank) — see the standing note in
   `EXPERIMENTS.md`; a `sui` CLI build was re-attempted tonight as a background, time-boxed side
   task (see PR description) and is a genuinely different situation from the last two nights (the
   `github.com`/`crates.io` blockers that stopped it before are gone), but did not finish compiling
   within tonight's window. Worth resuming, not re-diagnosing from scratch, next time.
