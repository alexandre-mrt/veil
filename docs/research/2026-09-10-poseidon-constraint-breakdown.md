# 2026-09-10 — Where the constraints actually go (queue item #2, reframed)

## Hypothesis

The per-gadget R1CS constraint cost of every circomlib template Veil's three circuits instantiate
(`Poseidon(2..5)`, `Num2Bits(8/64)`, `GreaterThan(64)`, `GreaterEqThan(8/64)`, `LessEqThan(64)`,
`MultiMux1(2)`) can be measured in isolation, and those isolated numbers reconstruct each full
circuit's measured total R1CS constraint count *exactly* — both the non-linear and linear
components — once circom's default `--O1` optimization behavior (eliminate pure signal-to-signal
and signal-to-constant equalities; never eliminate anything non-linear or a signal tied to a
*combination* of two-or-more other signals) is accounted for. If this holds, "which gadget
dominates prover time" stops being read off the README's prose and becomes an arithmetic fact
anyone can re-derive from `snarkjs r1cs info` runs on tiny circuits.

This directly answers Open Question #4 from the 2026-07-22 baseline report ("what fraction of
[transfer/compliance's] constraints come from the four Poseidon instances vs the `Num2Bits(64)`
range checks?") and reframes queue item #2 (originally scoped as "swap to Poseidon2 and measure
the delta") into the measurement half of that work — the half that's actually achievable tonight
without hand-rolling a cryptographic permutation from an unverified reference. See Approach for why
the full Poseidon2 swap was rejected for tonight.

## Threat / privacy model

No adversary model changes: no circuit, Move module, or frontend code was modified. This is a
measurement-only night, like 2026-07-22. The same framing from that report applies here: **who
relies on these numbers, and what breaks if they're wrong.**

- **This research loop, on future nights.** Queue item #2 ("Poseidon2 vs current Poseidon") was
  ranked on the theory that "four Poseidon instances... dominate" transfer/compliance's non-linear
  constraints (README, 2026-07-22 baseline). Tonight's measurement shows that framing is
  *incomplete* — see Results. A future night that spent a multi-day effort re-deriving Poseidon2
  round constants to optimize the wrong four hash calls would have wasted real time chasing 18% of
  the cost while leaving 76-81% (the Merkle path) untouched. Getting this breakdown right before
  committing to a circuit rewrite is the entire value of tonight's experiment.
- **Anyone deciding whether a Merkle-depth change (queue item #4) or a hash-function change (queue
  item #2) is the higher-leverage lever** for cutting `transfer.circom`/`compliance.circom` proving
  time needs this breakdown, not just the aggregate constraint count, to make that call with
  numbers instead of intuition.

What this does **not** establish: it says nothing about whether Poseidon2 (or any alternative hash)
is actually faster in this exact BN254/circom setting — that requires a real, audited circuit
implementation, which tonight explicitly does not attempt (see Approach). It changes no security
property and maps to no STRIDE entry directly, but it directly informs future work against
`docs/threat-model.md` **RR5** (deposit-commitment linkability, mitigated in part by Merkle
accumulator anonymity-set size — a depth change is the queue-item-#4 lever, and this experiment
quantifies exactly what depth costs today: 10,400 of `transfer.circom`'s 13,611 constraints, 76.4%,
come from the depth-20 path alone) and indirectly informs **RR2** (trusted-setup risk scales with
circuit size/complexity, so knowing precisely where constraints come from matters for any future
proof-system migration, item #9).

Assumptions carried over unchanged: Groth16 soundness under the BN254 discrete-log assumption,
current Poseidon round constants/security level (`circomlib` v2.0.5, unmodified), dev-only trusted
setup (RR2, unchanged). Nothing here touches any of them.

## Approach

**What I built.** `scripts/bench/circuit-gadget-cost/` — twelve one-line circom circuits, each
instantiating exactly one circomlib (or Veil-local) template as `component main`:
`Poseidon(2)`, `Poseidon(3)`, `Poseidon(4)`, `Poseidon(5)`, `Num2Bits(8)`, `Num2Bits(64)`,
`GreaterThan(64)`, `GreaterEqThan(8)`, `GreaterEqThan(64)`, `LessEqThan(64)`, `MultiMux1(2)`, and
the composite `MerkleProof(20)` (Veil's own template, `circuits/templates/merkle_proof.circom`) —
plus `run.sh`, which compiles each with `circom --r1cs` (no flags — same default `--O1` optimization
level `circuits/scripts/compile*.sh` already use for the real circuits) and reads `snarkjs r1cs
info`. Reproduce: `bash scripts/bench/circuit-gadget-cost/run.sh` (needs `circom` on `PATH` and
`circuits/node_modules` installed).

I then hand-counted every component instantiation and every top-level `<==`/`===` "glue" statement
in `transfer.circom`, `compliance.circom`, and `withdraw.circom` directly from source, and summed
the isolated-gadget numbers to predict each circuit's total — see Results for the exact arithmetic.

**What I rejected.**

- **A full Poseidon2 circuit swap** (the originally-queued framing of item #2). No audited Poseidon2
  circom implementation exists to vendor: `circomlib` is at npm version `2.0.5` (checked via `npm
  view circomlib versions`) and does not ship a `poseidon2.circom` template; no `poseidon2-circom`
  or similarly-scoped package exists on npm (checked directly — `404` for `poseidon2-circom` and
  `circomlib-poseidon2`). The only npm package found (`poseidon2@0.4.2`) is a plain TypeScript
  hash function, not a circom circuit, and using it would still require independently deriving and
  hand-verifying Poseidon2's round constants and the internal/external linear-layer matrices for
  BN254 at the relevant arities — a real cryptographic-implementation task, not a parameter tweak,
  and not something to do without a reference implementation to check against inside one measurement
  session. Shipping a hand-rolled permutation as a "circuit change" without that verification would
  violate the soundness bar this loop holds circuit changes to, so I did not attempt it. This is
  exactly the kind of PARK the prompt anticipates: promising, blocked on a missing dependency
  (an audited Poseidon2 circom template), which now goes back into the queue explicitly scoped that
  way (see EXPERIMENTS.md).
- **Re-deriving Poseidon2's published round-count reduction and projecting a percentage saving.**
  I considered citing the Poseidon2 paper's (Grassi, Khovratovich, Schofnegger 2023) reported
  round-count reduction and multiplying it against tonight's measured per-instance costs to produce
  an estimated saving. Rejected: the paper's reduction is round-count, not R1CS-constraint-count,
  and the two don't translate 1:1 once circom's own constraint-generation and `--O1` elimination are
  in the loop (tonight's own results show exactly how easy that translation is to get wrong — see
  the `--O1` correction below). Presenting an arithmetic projection dressed as a number would violate
  "no estimates presented as measurements." I say what's publicly known about Poseidon2 in Open
  Questions, explicitly unmeasured, and stop there.
- **Measuring gadget cost by diffing whole-circuit compiles** (comment out one assertion, recompile,
  subtract). Rejected in favor of isolated single-gadget circuits: diffing risks `--O1` optimizing
  differently across the two versions of the circuit (exactly the effect this experiment ended up
  needing to characterize precisely), so it would silently launder the same confound I was trying to
  measure. Isolated compiles plus an explicit, checked correction for `--O1` behavior is slower to
  set up but leaves no ambiguity about where each constraint came from.

## Results

### Isolated gadget cost (raw `circom --r1cs` + `snarkjs r1cs info`, no flags — default `--O1`)

| Gadget | Non-linear | Linear | Total |
|---|---|---|---|
| `Poseidon(2)` | 243 | 274 | 517 |
| `Poseidon(3)` | 264 | 341 | 605 |
| `Poseidon(4)` | 300 | 436 | 736 |
| `Poseidon(5)` | 324 | 511 | 835 |
| `Num2Bits(8)` | 8 | 1 | 9 |
| `Num2Bits(64)` | 64 | 1 | 65 |
| `GreaterThan(64)` | 65 | 3 | 68 |
| `GreaterEqThan(8)` | 9 | 4 | 13 |
| `GreaterEqThan(64)` | 65 | 4 | 69 |
| `LessEqThan(64)` | 65 | 4 | 69 |
| `MultiMux1(2)` | 2 | 0 | 2 |
| `MerkleProof(20)` (composite) | 4,920 | 5,480 | 10,400 |

Raw output (`bash scripts/bench/circuit-gadget-cost/run.sh`):

```
circom version: circom compiler 2.2.2

=== poseidon2 ===
non-linear constraints: 243
linear constraints: 274
[INFO]  snarkJS: # of Constraints: 517

=== poseidon3 ===
non-linear constraints: 264
linear constraints: 341
[INFO]  snarkJS: # of Constraints: 605

=== poseidon4 ===
non-linear constraints: 300
linear constraints: 436
[INFO]  snarkJS: # of Constraints: 736

=== poseidon5 ===
non-linear constraints: 324
linear constraints: 511
[INFO]  snarkJS: # of Constraints: 835

=== num2bits8 ===
non-linear constraints: 8
linear constraints: 1
[INFO]  snarkJS: # of Constraints: 9

=== num2bits64 ===
non-linear constraints: 64
linear constraints: 1
[INFO]  snarkJS: # of Constraints: 65

=== greaterthan64 ===
non-linear constraints: 65
linear constraints: 3
[INFO]  snarkJS: # of Constraints: 68

=== greaterequalthan8 ===
non-linear constraints: 9
linear constraints: 4
[INFO]  snarkJS: # of Constraints: 13

=== greaterequalthan64 ===
non-linear constraints: 65
linear constraints: 4
[INFO]  snarkJS: # of Constraints: 69

=== lessequalthan64 ===
non-linear constraints: 65
linear constraints: 4
[INFO]  snarkJS: # of Constraints: 69

=== multimux1_2 ===
non-linear constraints: 2
linear constraints: 0
[INFO]  snarkJS: # of Constraints: 2

=== merkleproof20 ===
non-linear constraints: 4920
linear constraints: 5480
[INFO]  snarkJS: # of Constraints: 10400
```

Internal cross-check: `MerkleProof(20)` = 20 × (`Poseidon(2)` + `MultiMux1(2)` + one boolean
constraint `pathIndices[i]*(1-pathIndices[i])===0` per level) = 20 × (517 + 2 + 1) = 20 × 520 =
**10,400**, non-linear 20 × (243 + 2 + 1) = **4,920** — both match the composite measurement exactly.

### The `--O1` correction (why component sums don't just add up)

circom's default optimization (confirmed via `circom --help`: `--O1` is "the default option...
applies signal to signal and signal to constant simplification") **eliminates** every top-level
`<==`/`===` of the form `signal === signal` or `signal === constant` — these compile to zero
constraints in the R1CS. It does **not** eliminate a signal tied to a *linear combination of two or
more other signals* (e.g. `a === b + c`), and it never touches anything non-linear (a product of two
signals, or a boolean-enforcement `x*(1-x)===0`). This one rule, read directly off the `--O1`
description, correctly predicts every discrepancy below without needing to disassemble circom's
optimizer:

| Circuit | Component-sum prediction | `--O1` correction | Predicted total | **Measured total** |
|---|---|---|---|---|
| `transfer.circom` | 13,610 | +1 (C3: `cumulativeNew === cumulativeOld + txAmount`, signal-to-linear-combo, survives `--O1`) | 13,611 | **13,611** |
| `compliance.circom` | 12,740 | +3 (two boolean-enforcement constraints on comparator outputs, one explicit AND-product `computedValid <== expiryCheck.out * kycCheck.out` — all non-linear, none eliminable) | 12,743 | **12,743** |
| `withdraw.circom` | 3,057 | +1 (C6: `remainingBalance <== cumulativeOld - withdrawAmount`, signal-to-linear-combo) | 3,058 | **3,058** |

Every other `===`/`<==` in all three circuits (`oldCommitment === oldHash.out`,
`merkleRoot === membershipProof.root`, `nullifier === nfHash.out`, `gtZero.out === 1`, etc. — 7 in
`transfer.circom`, 4 in `compliance.circom`, 6 in `withdraw.circom`) is a pure signal-to-signal or
signal-to-constant equality and contributes exactly zero to the final count, confirmed by the exact
match above. The reconciliation holds **separately** for non-linear and linear constraint counts too
(not just the combined total), which rules out the match being a coincidence of two compensating
errors:

| Circuit | Non-linear: predicted | Non-linear: measured | Linear: predicted | Linear: measured |
|---|---|---|---|---|
| `transfer.circom` | 6,470 | **6,470** | 7,141 | **7,141** |
| `compliance.circom` | 6,057 | **6,057** | 6,686 | **6,686** |
| `withdraw.circom` | 1,465 | **1,465** | 1,593 | **1,593** |

(Full component-by-component arithmetic for all three circuits, including every individual gadget
instantiation, is in the PR diff / commit for this report — omitted here for length; the totals
above are the reconciliation, and `run.sh`'s output plus a straight read of each `.circom` file's
component list reproduces it exactly.)

Command output for the full-circuit totals (re-measured tonight, on the same `circom` build used for
the gadget circuits above, to confirm they're mutually consistent — not copied from the 2026-07-22
baseline):

```
$ circom transfer.circom --r1cs -o build -l node_modules
non-linear constraints: 6470
linear constraints: 7141
$ npx snarkjs r1cs info build/transfer.r1cs
[INFO]  snarkJS: # of Constraints: 13611

$ circom compliance.circom --r1cs -o build-compliance -l node_modules
non-linear constraints: 6057
linear constraints: 6686
$ npx snarkjs r1cs info build-compliance/compliance.r1cs
[INFO]  snarkJS: # of Constraints: 12743

$ circom withdraw.circom --r1cs -o build-withdraw -l node_modules
non-linear constraints: 1465
linear constraints: 1593
$ npx snarkjs r1cs info build-withdraw/withdraw.r1cs
[INFO]  snarkJS: # of Constraints: 3058
```

These reproduce the 2026-07-22 `BASELINE.md` figures exactly (same `circom`/`snarkjs` versions,
fresh compile — `circom` was rebuilt from source this session, see Open Questions on toolchain
persistence).

### The finding: the Merkle path dominates, not the domain-tagged hashes

| Circuit | Total non-linear | From `MerkleProof(20)` (20× `Poseidon(2)`) | % from Merkle path | From the domain-tagged Poseidon(3/4/5) calls | % from those |
|---|---|---|---|---|---|
| `transfer.circom` | 6,470 | 4,920 | **76.0%** | 1,164 (3×`Poseidon(4)` + 1×`Poseidon(3)`) | 18.0% |
| `compliance.circom` | 6,057 | 4,920 | **81.2%** | 852 (1×`Poseidon(5)` + 2×`Poseidon(3)`) | 14.1% |
| `withdraw.circom` | 1,465 | 0 (no Merkle proof) | 0% | 1,143 (3×`Poseidon(4)` + 1×`Poseidon(2)`) | 78.0% |

`README.md` and the 2026-07-22 baseline both describe "four Poseidon instances" as what dominates
`transfer.circom`/`compliance.circom`'s constraint count. That framing is the reason queue item #2
was scoped around swapping *those* four domain-tagged calls to Poseidon2. Tonight's breakdown shows
the actual dominant cost in both circuits is the 20-deep Merkle authentication path — a single
`Poseidon(2)` call repeated 20 times per proof, contributing 76-81% of non-linear constraints,
against 14-18% for the domain-tagged commitment/nullifier/context hashes combined. `withdraw.circom`
has no Merkle path (by design — see its header comment on withdrawal linkability) and its Poseidon
cost is dominated by its three `Poseidon(4)` calls instead, at 78%, consistent with the "four
Poseidon instances" framing being correct *specifically for circuits without a Merkle path*.

The leverage math: optimizing a hash used once per proof (any of the domain-tagged calls) saves that
hash's marginal constraint cost, once. Optimizing the 2-ary hash used in the Merkle path saves it
**20 times** per proof. A hash-function change that helps `Poseidon(2)` specifically is worth roughly
4x the payoff of a change that helps `Poseidon(4)`, purely from call-count multiplicity, before even
asking whether Poseidon2's savings are arity-dependent.

### Test suite (run in full where the toolchain allowed it)

No circuit, Move, or frontend code changed tonight — this is a regression check, not evidence for
the hypothesis above.

| Suite | Result | Command |
|---|---|---|
| Circuits (HASH-ONLY / fallback mode) | **108/108 pass** (43 transfer + 30 compliance + 35 withdraw) | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils (credential leaf, Merkle builder, depth-20 proof) | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Property-based fuzz (fast-check) | **6/6 properties pass**, 500 runs each | `cd scripts && bun run src/fuzz-tests.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Circuits (real Groth16 full-proof mode) | **NOT RUN** | Needs `pot15_final.ptau` (`circuits/scripts/compile.sh`'s URL, `storage.googleapis.com`) — blocked by egress policy tonight (`403`, confirmed via direct `curl`), same class of blocker as queue item #1's network restrictions. The 2026-07-22 baseline already established 108/108 real-proof passes on unchanged circuits; tonight only reruns the fallback mode, which is a linting aid per `README.md`, not a substitute. |
| Move contracts | **NOT RUN** | `sui` CLI unavailable — same blocker as 2026-07-22 and the Addendum above. |

Everything runnable tonight is green; nothing was loosened, skipped, or given new tolerance. The two
NOT-RUN rows are pre-existing, documented toolchain blockers unrelated to tonight's change (no
circuit or Move code touched) — same posture the 2026-07-22 baseline PR merged under.

## Verdict: **KEEP**

The gadget-level constraint breakdown is real, measured, exactly reconciled (to the constraint, for
both non-linear and linear counts, across all three circuits), and reproducible via
`scripts/bench/circuit-gadget-cost/run.sh`. No circuit, Move module, or frontend code changed — this
is measurement infrastructure and a documented finding, not a protocol change, so no soundness
argument / leakage analysis / negative test is required (nothing that affects what a proof verifies
or what an observer learns was touched).

`BASELINE.md` is updated with a new "Constraint cost by gadget" section carrying this table, so
future scalability/crypto queue items (Poseidon2, Merkle-depth changes, item #4) have the
per-gadget number to size their potential payoff against, instead of re-deriving it from scratch.

The originally-queued "swap to Poseidon2" experiment is **not** settled by tonight's work — it
remains queued, but re-scoped: EXPERIMENTS.md is updated to target the Merkle-path `Poseidon(2)`
specifically (not the four domain-tagged calls) and to name its real blocker (no audited Poseidon2
circom implementation exists to vendor — this is a PARK, not a REJECT, since the gap is a missing
dependency, not a bad idea).

## Addendum: queue item #1 (on-chain gas) re-attempted, still BLOCKED — for a different, more definitive reason

Per the queue's own instruction ("worth spending an early part of the next run purely on unblocking
the toolchain before attempting the measurement"), I spent the first part of tonight re-attempting
item #1 before starting the experiment above. It remains BLOCKED, but the reason is now precise
rather than a transient tool-approval denial (as it was on 2026-07-22):

- `sui` CLI: no prebuilt binary reachable — `github.com/MystenLabs/sui` (releases page, and the
  `api.github.com/repos/MystenLabs/sui/releases` API) returns `403` with an explicit message that
  this session's GitHub access is scoped to `alexandre-mrt/veil` only, not a generic network
  failure. `codeload.github.com/MystenLabs/sui/tar.gz/...` (tarball download) is blocked the same
  way. No `sui`/`sui-cli` package exists via `apt-cache search` or `snap`. No `sui` crate exists on
  `crates.io` (confirmed via a direct `index.crates.io` sparse-index lookup — `NoSuchKey`). Building
  from source therefore isn't just "impractical within a night's budget" (2026-07-22's framing) —
  the source itself isn't fetchable this session at all, by design, not by accident.

  (Interestingly, `git clone` of a *different* public GitHub repo, `iden3/circom`, worked fine
  tonight, as did `raw.githubusercontent.com` reads of arbitrary files from `MystenLabs/sui` — so
  this isn't a blanket GitHub outage; it's specifically that this session's GitHub tooling access is
  scoped to the one repository it's working in, and that scope also gates the plain-HTTPS release/
  API/codeload paths for every other repo.)

- Direct JSON-RPC to the public Sui testnet fullnode (`fullnode.testnet.sui.io:443`,
  `suix_queryTransactionBlocks` against the real deployed package/pool from `README.md`): blocked at
  the network egress layer (`CONNECT` rejected, `403`, organization policy) — confirmed by a direct
  `curl` test and cross-checked against the proxy's own status endpoint, not merely inferred from a
  denied tool call this time.

Net: this is a session-configuration blocker (GitHub access scope + egress policy), not a toolchain
gap that more effort would fix. Re-ranked in `EXPERIMENTS.md` with this precise reason recorded, and
demoted below item #2's outcome and the newly-scoped Merkle-depth item, since neither of those needs
broader network or GitHub access to attempt next. If a future night runs with `sui` CLI access
(broader GitHub scope, or the binary pre-installed in the environment), item #1 becomes trivial —
nothing about the *measurement* is hard, only the toolchain access has been unavailable three nights
running now, for three different specific reasons each time.

## Where this could be used

- **Any circom/Groth16 circuit with a fixed-depth Merkle-membership subcircuit** (nullifier sets,
  UTXO accumulators, credential trees — the shape is generic to shielded-pool design, not specific
  to Veil) should run this same isolate-and-reconcile exercise before optimizing any hash function:
  the Merkle path's call-count multiplier (depth × per-level hash cost) very plausibly dominates
  over single-use domain-tagged hashes in any protocol using this pattern, not just this one.
- **A thesis chapter or audit report arguing for a specific circuit optimization** needs exactly this
  kind of "prove the bottleneck before fixing it" evidence — a reviewer asking "why Poseidon2 instead
  of a smaller Merkle depth" now has a table to point at instead of an intuition.
- **Confidential payroll or compliance-gated DeFi on Sui** (the same use case named in the
  2026-07-22 report) inherits this directly: `compliance.circom`'s credential Merkle tree is the same
  shape, and this table says precisely how much of its cost is the tree vs. the credential-specific
  hashes — relevant to anyone sizing a t-of-n auditor board's proving cost (queue item #6).

## Open questions (next queue)

1. **An audited Poseidon2 circom implementation** is the actual blocker for measuring a real
   Poseidon2 delta (not "Poseidon2 in general" — specifically for the `Poseidon(2)` used in the
   Merkle path, per tonight's finding). Worth checking `iden3/circomlib`'s `main` branch (unreleased)
   or `zkcrypto`/other audited ZK-hash libraries for a maintained Poseidon2 circuit before the next
   attempt at this experiment, rather than re-deriving round constants by hand.
2. Given the Merkle path dominates, **queue item #4 (Merkle accumulator at scale, depth vs
   anonymity-set trade-off)** and this Poseidon2-blocker item are now two independent levers on the
   *same* cost center. A depth reduction (e.g. depth-16 instead of depth-20) is immediately
   measurable with today's toolchain (no new library needed) and trades anonymity-set size (2^16 vs
   2^20 leaves) for a proportional cut in Merkle-path constraints — worth measuring before or
   alongside the Poseidon2 blocker, since it needs no new dependency.
3. Publicly, Poseidon2 (Grassi et al., 2023) is reported to reduce the number of *rounds* needed for
   equivalent security over Poseidon — but round-count reduction and R1CS-constraint-count reduction
   are not the same number (this experiment's own `--O1` correction shows how easy that translation
   is to get subtly wrong), so this stays explicitly UNMEASURED until a real implementation exists to
   compile and count.
4. `circom` and its build toolchain are not persisted between sessions (rebuilt from source again
   tonight, ~80 seconds via `cargo build --release` against `iden3/circom` tag `v2.2.2` — fast enough
   that this isn't a real blocker, but worth noting since queue item #1's on-chain-gas blocker
   partly hinges on toolchain persistence across nights being unavailable here too).
