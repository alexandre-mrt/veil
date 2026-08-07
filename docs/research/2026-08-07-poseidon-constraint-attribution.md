# 2026-08-07 — R1CS non-linear constraint attribution (queue item #2, alternate framing)

## Hypothesis

Each Veil circuit's R1CS non-linear constraint count — the number that dominates Groth16 proving
time (`BASELINE.md`) — can be decomposed into named contributions from the gadgets it instantiates
(Poseidon at each arity, `Num2Bits`, the comparators, the depth-20 Merkle path), by compiling every
gadget in isolation and summing, without touching any production circuit. The decomposition should
account for at least 99% of the real compiled circuit's constraint count; any larger residual would
mean the model of "a circuit's cost is the sum of its named parts" is wrong, which would itself be a
finding.

This is queue item #2's alternate framing ("re-deriving the exact non-linear-constraint contribution
per Poseidon instance from the current baseline," offered in `EXPERIMENTS.md` as an equally valid
substitute for actually swapping to Poseidon2). It was chosen over the literal Poseidon2 swap for a
concrete reason explained under Approach.

## Threat / privacy model

No adversary model changes here. Nothing about soundness, privacy, or trust boundaries is touched —
this is a measurement night, not a protocol change, and no circuit, Move module, or frontend proving
code was modified. `scripts/bench/gadget-attribution/gadgets/*.circom` are standalone benchmark
circuits (a single circomlib/local template each, `component main = Poseidon(4)` and similar) that
are never compiled into a zkey, never touch a trusted setup, and are not referenced by anything the
frontend or contracts import.

Who relies on these numbers being honest, same framing as the 2026-07-22 baseline report: this
research loop itself, on every future night that touches constraint count (a real Poseidon2 port, a
Merkle-depth change, a different accumulator) — the attribution table is what tells that work where
the leverage actually is instead of guessing. It maps to no STRIDE entry directly; it's diagnostic
input for a future scalability entry, not a mitigation.

What this does **not** establish: whether 13,611 constraints is *good*, whether the dev-only trusted
setup is production-safe (RR2, unchanged), or anything about on-chain gas (see Toolchain note below).
Assumptions carried over unchanged: Groth16/BN254 soundness, dev-ceremony toxic waste not being
production-safe.

## Approach

**What I built.** `scripts/bench/gadget-attribution/`:

- `gadgets/*.circom` — twelve single-component circuits, one per gadget instantiated anywhere in
  `transfer.circom`, `compliance.circom`, or `withdraw.circom`: `Poseidon(2)`, `Poseidon(3)`,
  `Poseidon(4)`, `Poseidon(5)`, `Num2Bits(64)`, `Num2Bits(8)`, `LessEqThan(64)`, `GreaterThan(64)`,
  `GreaterEqThan(64)`, `GreaterEqThan(8)`, `MultiMux1(2)` (the per-level selector inside the Merkle
  template), and `MerkleProof(20)` as its own composite unit (it is not flat — it wraps
  `Poseidon(2)` + `MultiMux1(2)` + a boolean range check per level, twenty times).
- `measure.mjs` — compiles each gadget with `circom --r1cs`, parses the compiler's own
  `non-linear constraints:` / `linear constraints:` summary lines, then greps
  `circuits/{transfer,compliance,withdraw}.circom` for `= GadgetName(...)` component instantiations
  to get a real per-circuit instance count (not hand-maintained — it re-derives from source), sums
  `count × isolated-gadget-constraints` per circuit, and compiles the real circuit alongside it so
  predicted vs. actual is printed side by side, every run.

**What I rejected, and why this experiment instead of the literal Poseidon2 swap.** The queue
framed this as "measure a real Poseidon2 delta, or fall back to attributing constraints per Poseidon
instance." I looked for an existing, trustworthy Poseidon2 circom implementation to swap in — none
ships in `circomlib`, and hand-deriving Poseidon2's round constants and internal partial-round
matrix from the paper and typing it into a new circom template overnight is exactly the kind of
homebrew-cryptography risk this loop's own rules warn against (a circuit change requires a soundness
argument and a negative test; getting the constants subtly wrong would produce a broken or
insecure hash, not a benchmark). Before committing to that multi-night effort, I checked what the
literal swap would actually buy in **this** proof system:

> Web search (not independently fetched — `arxiv.org` and `eprint.iacr.org` are blocked by this
> session's network egress policy, so this is a literature claim, not a measurement of mine) on
> "Benchmarking ZK-Friendly Hash Functions and SNARK Proving Systems" (arXiv:2409.01976) reports
> Poseidon and Poseidon2 both costing **~240 R1CS constraints per hash under Groth16** — comparable,
> not a large win. Poseidon2's real gains (reduced linear-layer multiplications, up to ~70% fewer
> constraints) are reported for **Plonk-style arithmetization**, not R1CS/Groth16, which is what
> every Veil circuit uses.

If that literature claim holds, a from-scratch Poseidon2 port would be a multi-night, real-crypto-risk
effort to move a number that, in Veil's actual proof system, might not move much. That reprioritizes
the question from "which hash function" to "how many hash calls, and where" — which is exactly what
constraint attribution answers with real numbers, cheaply and with zero soundness risk. I did not
independently verify the ~240-constraint figure against the primary source (network egress blocked
it); it should be treated as a pointer for whoever picks up queue item #9 (Poseidon2 / proof-system
work) to verify before committing engineering time to a hash swap, not as an established fact.

**Toolchain gaps hit along the way:**

- `circom` — same as 2026-07-22: not installed, not on crates.io. Rebuilt from source
  (`iden3/circom` tag `v2.2.2`, `cargo build --release`, ~40s), used by full path.
- **On-chain gas per entry point (queue item #1)** — attempted again before falling back to this
  experiment, per `EXPERIMENTS.md`'s note to spend early effort unblocking it. New information
  this time, different from both prior attempts:
  - `github.com` git-protocol clone of `MystenLabs/sui` **works** (`git ls-remote` succeeded), and
    `cargo install --git ... sui --branch testnet` got past dependency resolution and **into real
    compilation** (`sui-types`, `move-command-line-common`, and dozens of transitive crates built
    successfully) — this session's network policy is not the blocker the last two nights hit.
  - The blocker now is compute, not network: this sandbox has 4 vCPUs and 15 GB RAM, `sui`'s own
    binary pulls in most of the Sui workspace (validator, indexer, Move VM, narwhal/consensus), and
    a full build was still compiling mid-tier crates after ~15 minutes with hundreds left — a
    multi-hour job on this hardware, consistent with the 2026-07-22 report's original judgment call,
    now with a concrete data point instead of a guess. The in-progress build was lost to an
    unrelated container restart mid-session and was not restarted, to keep this a one-hypothesis
    night as the instructions ask.
  - Also worth recording for whoever attempts this next: even a successfully built `sui` CLI can't
    reach `fullnode.testnet.sui.io` from this sandbox (`curl` to it returns a `403` via the network
    proxy — confirmed directly, independent of the CLI). So a built CLI alone doesn't unblock a
    *testnet* gas read. The one path that sidesteps both problems is a fully local
    `sui start` localnet (genesis + validator + faucet, no external network), publish
    `contracts/` locally, exercise each entry point with real proofs (the 2026-07-22 harness already
    builds those), and read gas from the local transaction effects — CLI build time is still the
    gating cost, not network access.
  - Re-parked at the top of `EXPERIMENTS.md` with this detail so the next attempt doesn't re-litigate
    the network question and can go straight to budgeting a dedicated multi-hour build (or a
    background build kicked off at the very start of a future night, left running while that night's
    actual experiment proceeds on the remaining CPU).

## Results

### Isolated gadget constraints (`circom --r1cs`, this machine, circom 2.2.2)

| Gadget | Non-linear | Linear | Total | Wires |
|---|---|---|---|---|
| `Poseidon(2)` | 243 | 274 | 517 | 520 |
| `Poseidon(3)` | 264 | 341 | 605 | 609 |
| `Poseidon(4)` | 300 | 436 | 736 | 741 |
| `Poseidon(5)` | 324 | 511 | 835 | 841 |
| `Num2Bits(64)` | 64 | 1 | 65 | 66 |
| `Num2Bits(8)` | 8 | 1 | 9 | 10 |
| `LessEqThan(64)` | 65 | 4 | 69 | 71 |
| `GreaterThan(64)` | 65 | 3 | 68 | 70 |
| `GreaterEqThan(64)` | 65 | 4 | 69 | 71 |
| `GreaterEqThan(8)` | 9 | 4 | 13 | 15 |
| `MultiMux1(2)` | 2 | 0 | 2 | 8 |
| `MerkleProof(20)` (composite: 20×(`Poseidon(2)` + `MultiMux1(2)` + 1 boolean check)) | 4,920 | 5,480 | 10,400 | 10,422 |

### Per-circuit attribution: predicted (sum of parts) vs. actual (real compile)

| Circuit | Predicted non-linear | Actual non-linear | Predicted linear | Actual linear | Residual | Coverage |
|---|---|---|---|---|---|---|
| `transfer.circom` | 6,470 | 6,470 | 7,140 | 7,141 | 1 (linear) | 99.99% |
| `compliance.circom` | 6,054 | 6,057 | 6,686 | 6,686 | 3 (non-linear) | 99.98% |
| `withdraw.circom` | 1,465 | 1,465 | 1,592 | 1,593 | 1 (linear) | 99.97% |

The residual in every circuit is 0–3 constraints out of 1,465–13,611 — top-level R1CS wiring (a bare
addition/equality not inside any named subcomponent) that the model doesn't capture, not an error in
it. This is as close to full attribution as this method gets.

### Where each circuit's non-linear cost actually comes from

| Circuit | Contributor | Non-linear constraints | Share |
|---|---|---|---|
| `transfer.circom` (6,470 total) | `MerkleProof(20)` (Merkle-membership check) | 4,920 | 76.0% |
| | `Poseidon(4)` × 3 (old/new commitment, nullifier) | 900 | 13.9% |
| | `Poseidon(3)` × 1 (amount hash) | 264 | 4.1% |
| | `Num2Bits(64)` × 4 (range checks) | 256 | 4.0% |
| | `GreaterThan(64)` + `LessEqThan(64)` | 130 | 2.0% |
| `compliance.circom` (6,057 total) | `MerkleProof(20)` (credential-membership check) | 4,920 | 81.2% |
| | `Poseidon(3)` × 2 (nullifier, context) | 528 | 8.7% |
| | `Poseidon(5)` × 1 (credential leaf) | 324 | 5.3% |
| | `Num2Bits(64)` × 3 + `Num2Bits(8)` × 2 | 208 | 3.4% |
| | `GreaterEqThan(64)` + `GreaterEqThan(8)` | 74 | 1.2% |
| `withdraw.circom` (1,465 total) | `Poseidon(4)` × 3 (commitment, change, nullifier) | 900 | 61.4% |
| | `Poseidon(2)` × 1 (recipient hash) | 243 | 16.6% |
| | `Num2Bits(64)` × 3 | 192 | 13.1% |
| | `GreaterThan(64)` + `LessEqThan(64)` | 130 | 8.9% |

All hashing (every Poseidon arity, plus the Merkle path's `Poseidon(2)` calls) accounts for **93–94%**
of `transfer.circom`'s and `compliance.circom`'s non-linear constraints, and **78%** of
`withdraw.circom`'s (which has no Merkle path). In both circuits that carry a Merkle proof, the
**single depth-20 membership check — 20 `Poseidon(2)` calls — is 75–80% of the entire circuit's
non-linear cost on its own**, more than all the "identity" Poseidon calls (commitment, nullifier,
leaf, context) combined.

### Raw command output

```
$ CIRCOM_BIN=/tmp/circom-build/target/release/circom node scripts/bench/gadget-attribution/measure.mjs
=== Veil R1CS gadget-attribution benchmark ===
circom binary: /tmp/circom-build/target/release/circom
circom compiler 2.2.2

--- Poseidon(2) (poseidon2.circom) ---
  non-linear: 243   linear: 274   total: 517   wires: 520
--- Poseidon(3) (poseidon3.circom) ---
  non-linear: 264   linear: 341   total: 605   wires: 609
--- Poseidon(4) (poseidon4.circom) ---
  non-linear: 300   linear: 436   total: 736   wires: 741
--- Poseidon(5) (poseidon5.circom) ---
  non-linear: 324   linear: 511   total: 835   wires: 841
--- Num2Bits(64) (num2bits64.circom) ---
  non-linear: 64   linear: 1   total: 65   wires: 66
--- Num2Bits(8) (num2bits8.circom) ---
  non-linear: 8   linear: 1   total: 9   wires: 10
--- LessEqThan(64) (lesseqthan64.circom) ---
  non-linear: 65   linear: 4   total: 69   wires: 71
--- GreaterThan(64) (greaterthan64.circom) ---
  non-linear: 65   linear: 3   total: 68   wires: 70
--- GreaterEqThan(64) (greaterequalthan64.circom) ---
  non-linear: 65   linear: 4   total: 69   wires: 71
--- GreaterEqThan(8) (greaterequalthan8.circom) ---
  non-linear: 9   linear: 4   total: 13   wires: 15
--- MerkleProof(20) (merkleproof20.circom) ---
  non-linear: 4920   linear: 5480   total: 10400   wires: 10422
--- MultiMux1(2) (multimux1_x2.circom) ---
  non-linear: 2   linear: 0   total: 2   wires: 8

=== transfer.circom ===
  Poseidon(3) x1: non-linear 1*264=264, linear 1*341=341
  Poseidon(4) x3: non-linear 3*300=900, linear 3*436=1308
  Num2Bits(64) x4: non-linear 4*64=256, linear 4*1=4
  LessEqThan(64) x1: non-linear 1*65=65, linear 1*4=4
  GreaterThan(64) x1: non-linear 1*65=65, linear 1*3=3
  MerkleProof(20) x1: non-linear 1*4920=4920, linear 1*5480=5480
  --- predicted total: non-linear 6470, linear 7140, sum 13610 ---
  --- actual compiled circuit: non-linear 6470, linear 7141, sum 13611 ---
  residual (actual - predicted): non-linear 0, linear 1 (top-level R1CS wiring not covered by a named subcomponent)

=== compliance.circom ===
  Poseidon(3) x2: non-linear 2*264=528, linear 2*341=682
  Poseidon(5) x1: non-linear 1*324=324, linear 1*511=511
  Num2Bits(64) x3: non-linear 3*64=192, linear 3*1=3
  Num2Bits(8) x2: non-linear 2*8=16, linear 2*1=2
  GreaterEqThan(64) x1: non-linear 1*65=65, linear 1*4=4
  GreaterEqThan(8) x1: non-linear 1*9=9, linear 1*4=4
  MerkleProof(20) x1: non-linear 1*4920=4920, linear 1*5480=5480
  --- predicted total: non-linear 6054, linear 6686, sum 12740 ---
  --- actual compiled circuit: non-linear 6057, linear 6686, sum 12743 ---
  residual (actual - predicted): non-linear 3, linear 0 (top-level R1CS wiring not covered by a named subcomponent)

=== withdraw.circom ===
  Poseidon(2) x1: non-linear 1*243=243, linear 1*274=274
  Poseidon(4) x3: non-linear 3*300=900, linear 3*436=1308
  Num2Bits(64) x3: non-linear 3*64=192, linear 3*1=3
  LessEqThan(64) x1: non-linear 1*65=65, linear 1*4=4
  GreaterThan(64) x1: non-linear 1*65=65, linear 1*3=3
  --- predicted total: non-linear 1465, linear 1592, sum 3057 ---
  --- actual compiled circuit: non-linear 1465, linear 1593, sum 3058 ---
  residual (actual - predicted): non-linear 0, linear 1 (top-level R1CS wiring not covered by a named subcomponent)
```

### Test suite (run where the toolchain allowed it — no production code changed tonight)

| Suite | Result | Command |
|---|---|---|
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Circuits (real Groth16) | **NOT RUN** | Would require re-downloading the ~85 MB pot15 ptau and redoing the dev trusted-setup ceremony from scratch (this session's container was restarted mid-run and `circuits/build*` was never populated); no circuit input, witness, or constraint logic changed tonight, and the isolated gadget circuits compiling to the exact predicted constraint counts is itself strong evidence they're wired correctly. Real risk from skipping is low but this is a verification gap, not a passing claim — flagged, not hidden. |
| Move contracts | **NOT RUN** (same blocker as 2026-07-22) | `sui` CLI unavailable — see Toolchain note above. |

No test was loosened, skipped, or given new tolerance. Nothing in `circuits/{transfer,compliance,withdraw}.circom` changed, so the constraint counts and proving times in `BASELINE.md` are unaffected and don't need updating for the circuit-cost rows — only the "not yet measured" row's wording changes (see below).

## Verdict: **KEEP**

The hypothesis held: 99.97–99.99% of every circuit's constraints are attributable to named gadgets,
computed from a script that re-derives instance counts from source rather than hand-maintained
numbers. `BASELINE.md` gets a new "Non-linear constraint attribution" section. The benchmark is
reusable — re-run `measure.mjs` after any circuit edit and the breakdown updates itself.

The more consequential finding is the redirection: the highest-leverage lever for constraint count in
transfer.circom and compliance.circom is not "which hash function" but **how many times the circuit
calls `Poseidon(2)` for the depth-20 Merkle path** (75–80% of non-linear constraints, dwarfing every
other gadget combined). Queue item #4 (Merkle accumulator scaling, depth vs. anonymity-set trade-off)
and queue item #9 (Poseidon2 / proof-system swap) should be read in that light — #4 now looks like
the higher-leverage of the two for constraint count specifically, and #9's literature-cited ~240
constraint/hash R1CS figure (unverified primary source, see Approach) suggests a Poseidon2 port may
not be worth the soundness risk unless it's independently confirmed first.

## Where this could be used

- **Any circom/Groth16 circuit with a Merkle-membership check** (nullifier sets, credential trees,
  UTXO accumulators) — this experiment's actual finding generalizes past Veil: a depth-`d` Poseidon
  Merkle path costs `d × 243` non-linear constraints in this circomlib implementation before any
  other circuit logic is added, so for any such circuit, the membership check is very likely the
  dominant cost the moment `d` exceeds a handful of levels, and that's worth checking with this same
  method before optimizing anything else.
- **A thesis chapter or audit checklist** for "where should I spend an optimization budget on a
  Groth16 circuit" — this decomposition method (isolate every gadget, sum, diff against the real
  compile) is a five-minute check that replaces guessing, and the near-100% attribution result here
  is itself evidence the method is trustworthy for circuits built from standard circomlib templates.
- **Anyone evaluating a Poseidon2 migration for an existing Groth16/R1CS circuit** — the literature
  pointer here (Poseidon2's real win is Plonk-style arithmetization, not R1CS) is worth verifying
  against the primary source before committing engineering time; if it holds, the same migration
  might be much more valuable for a Plonk/Halo2-based protocol than for a circom/Groth16 one like
  Veil.

## Open questions (next queue)

1. **Verify the ~240-constraint-per-hash Poseidon vs. Poseidon2 R1CS figure against the primary
   source** (`eprint.iacr.org/2023/323`, blocked from this sandbox tonight) before committing to or
   ranking down queue item #9. If the figure holds, item #9 should be re-ranked below item #4.
2. **Merkle-depth vs. constraint-count trade-off, with real numbers** — natural next step given
   tonight's finding: compile `MerkleProof(depth)` at several depths (this session already has the
   depth-20 number: 4,920 non-linear) and get the actual marginal cost per level (predictable at
   ~246/level from tonight's data — 243 Poseidon + 2 MultiMux + ~1 boolean — but worth confirming
   directly rather than extrapolating), directly informing queue item #4's anonymity-set-size
   trade-off.
3. **On-chain gas per entry point** — re-parked, see Toolchain note. Next attempt should budget a
   dedicated multi-hour window for the `sui` CLI build (or kick it off at the start of a night and
   let it run in the background across that night's actual experiment), then use a fully local
   `sui start` network rather than testnet RPC (confirmed still network-blocked independent of the
   CLI).
4. Does swapping the Merkle path's hash-only role (no algebraic structure needed beyond
   collision-resistance within the circuit) to a cheaper-arity or different accumulator change the
   security argument at all, or is it a pure performance lever? Worth a short soundness note before
   anyone acts on finding #2 above by actually changing `merkle_proof.circom`.
