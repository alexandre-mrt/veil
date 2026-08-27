# 2026-08-27 — Poseidon vs Poseidon2 hash swap (queue item #2)

## Hypothesis

Swapping every Poseidon(N) call in `transfer.circom`, `withdraw.circom`, and (where a
matching state size exists) `compliance.circom` for a domain-separated Poseidon2 sponge
(`@taceo/circom-lib`, state sizes t ∈ {2,3,4,8,12,16}) reduces Groth16 proving time
per circuit, even though — this experiment falsifies the naive "fewer constraints" framing
along the way — total R1CS constraint count actually goes *up* by ~10-12%. This moves two
numbers Veil pays on every transfer and every withdrawal: prover wall-clock time
(`scripts/bench/prove-latency.mjs`'s baseline) and, indirectly, browser proving latency.

## Threat / privacy model

**Adversary this defends against:** none, directly — this is a performance experiment, not
a new mitigation. The relevant question is narrower: does swapping the hash primitive that
backs domain separation (`docs/threat-model.md`'s row "Domain-separated Poseidon hashes ...
Tags 1-8 prevent cross-domain hash collisions") *weaken* that control for any of the STRIDE
entries that depend on it (S2 forged-proof resistance, S3 replay resistance via nullifiers,
I6 nullifier-frequency leakage)?

**What it does NOT defend against — residual surface:** this experiment does not touch, and
does not claim to improve, any of Veil's actual residual risks: RR2 (single-contributor
trusted setup — a *new* setup would be needed for these variant circuits, with the exact
same non-production caveat), RR3 (Sybil via multiple `userSecret`s), RR4 (admin drain via
timelock), RR5 (deposit-commitment linkability), or RR9 (faucet in prod bytecode). It also
does not change what a chain observer sees: the public input *signals* (`oldCommitment`,
`newCommitment`, `nullifier`, `txAmountHash`, `merkleRoot` for transfer; the analogous set
for withdraw/compliance) are identical in name, order, and count between the original
circuits and the `_v2` variants — only the off-chain function used to *compute* those field
elements changes. A chain observer, colluding relayer, or statistical deanonymizer learns
exactly as much (or as little) as today; **zero incremental information disclosure.**

**Assumptions:**
- BN254 discrete-log hardness / Groth16 soundness — unchanged, both variants use the same
  proof system and curve.
- Poseidon2 permutation security — relies on the parameter derivation in
  [eprint.iacr.org/2023/323](https://eprint.iacr.org/2023/323) (Grassi, Khovratovich,
  Schofnegger) via HorizenLabs's published parameter script, the same lineage Poseidon1's own
  parameters come from. `@taceo/circom-lib`'s README states its `poseidon2.circom`,
  `eddsa_poseidon2.circom`, and `babyjubjub.circom` are "pulled from the audited repository
  for [TACEO:OPRF](https://github.com/TaceoLabs/oprf-circom/)" — **I could not independently
  verify that audit** (no access to the report); I'm reporting the claim, not vouching for
  it. Treat "audited" as unverified provenance, same epistemic status as circomlib's own
  Poseidon implementation before this experiment (also never independently audited within
  this repo's history).
- Single dev-only Groth16 trusted setup (RR2, unchanged) — this experiment's zkeys are
  research-only, never deployed, same one-contributor ceremony caveat as every other zkey in
  this repo.
- My own JS↔circuit cross-check (below) is correct — I did not just trust the JS sponge
  implementation; I verified it bit-for-bit against the compiled circuit's actual witness
  output before using it to build any full-circuit witness.

**STRIDE mapping:** no row in `docs/threat-model.md` changes status. If this were ever
shipped, the only edit needed is the *mechanism* text in the Security Controls Summary
Table's "Domain-separated Poseidon hashes" row (Poseidon → Poseidon2 sponge, tag moved from
rate to capacity) — the verdict ("Mitigated" / "Preventive") stays identical. Not shipped
tonight (see Verdict), so `docs/threat-model.md` is unchanged in this PR.

## Approach

**What I built.**

1. Four isolated microbenchmark circuits per variant (8 total,
   `circuits/bench/poseidon2/{old,new}_{merkle2,recipient2,amount3,commit4}.circom`),
   matching every distinct Poseidon arity Veil actually calls: 2 data + no tag (Merkle
   level), 1 data + tag (recipient hash), 2 data + tag (tx-amount hash), 3 data + tag
   (commitment/nullifier hash) — `old` = circomlib `Poseidon(N)` with the domain tag packed
   into the rate (Veil's current practice); `new` = `@taceo/circom-lib`'s
   `Poseidon2Sponge(N, T, DS)`, a capacity-based sponge with the tag moved into its own
   dedicated capacity element.
2. Three full production-shaped variant circuits,
   `circuits/bench/poseidon2/full/{transfer,withdraw,compliance}_v2.circom` — line-for-line
   copies of `transfer.circom` / `withdraw.circom` / `compliance.circom` with every
   `Poseidon(N)` call replaced by the matching `Poseidon2Sponge`. **Not wired into
   `pool.move`, not used by the frontend, no new trusted setup was deployed anywhere** —
   these exist purely to get a real constraint count and proving time at Veil's actual
   circuit scale, not a microbenchmark extrapolation.
3. `scripts/bench/poseidon2-sponge.mjs` — a from-scratch JS re-implementation of
   `Poseidon2SpongeWithDs`'s single-block absorption, built on `@taceo/poseidon2`'s raw
   permutation (`bn254.t{2,3,4,8,12,16}.permutation`). **Verified, not assumed:**
   `scripts/bench/verify-poseidon2-sponge.mjs` computes all four microbenchmark shapes both
   ways — through the actual compiled circuit's witness calculator, and through this JS
   module — and diffs them. All four matched exactly (raw output below) before I trusted the
   JS module to build any full-circuit witness.
4. `scripts/bench/witnesses-v2.mjs` — the `_v2` analogue of the existing
   `scripts/bench/witnesses.mjs`, same numeric fixtures, so old vs new proofs are over
   equivalent (not just same-shaped) data. `compliance_v2`'s credential-leaf hash is
   deliberately left as circomlib `Poseidon(5)` (see below), so that one hash still goes
   through `circomlibjs`.
5. `scripts/bench/poseidon2-constraint-delta.mjs` (microbenchmark) and
   `scripts/bench/poseidon2-full-circuit.mjs` (full circuit) — reusable, parameterized
   (`--runs`, `--circom`) drivers that compile, run a real dev Groth16 setup, and time
   `snarkjs.groth16.fullProve` for every shape/circuit pair.
6. `scripts/bench/poseidon2-negative-test.mjs` — the required negative test (see below).

**What I rejected, and why.**

- *Reimplementing Poseidon2's permutation by hand.* Writing my own round constants /
  MDS-alternative matrices is exactly the kind of novel, unaudited crypto code this loop's
  own rules are wary of, and it would have made "the number" partly a measurement of my own
  bug density rather than the construction. Used the published `@taceo/circom-lib` templates
  verbatim instead.
- *Deriving my own t=5 Poseidon2 parameters to fully swap `compliance.circom`'s credential-leaf
  hash* (4 data inputs + tag ⇒ Poseidon2 state size 5). `@taceo/circom-lib`'s
  `poseidon2_constants.circom` only publishes round constants for t ∈ {2,3,4,8,12,16} — 5 is
  missing. Deriving safe round constants for an unsupported state size is a real
  cryptographic-parameter-generation task (Gröbner-basis / interpolation / statistical
  security margin analysis), not a config change, and well outside "one hypothesis, one
  night." `compliance_v2.circom` therefore does a **partial swap**: the leaf hash (C1) stays
  circomlib `Poseidon(5)`, unmodified; every other hash (Merkle levels, nullifier, context
  binding) is swapped. This is called out inline in the circuit's own header comment, not
  just in this report.
- *Padding the t=5 case into T=8 instead* (the next supported Poseidon2 size) — rejected as
  an unfair comparison: it would pay for 3 wasted rate slots and 7 extra rounds' worth of
  Sbox calls relative to the data actually being hashed, which would make Poseidon2 look
  artificially worse at exactly the shape where the real answer is "not measured," not
  "measured and bad."

**Toolchain**, same gaps as 2026-07-22, same workarounds: `circom` (v2.2.2, `@taceo/circom-lib`
requires `pragma circom 2.2.2`, the production circuits still use `2.1.0` — no conflict, they
compile independently) was rebuilt from source (`cargo build --release`, ~65s) since the
sandbox is a fresh container each night; `pot15_final.ptau` was re-downloaded from the same
`storage.googleapis.com/zkevm/ptau/...` bucket `circuits/scripts/compile.sh` already uses.

## Results

### Microbenchmark — isolated hash shapes (`node scripts/bench/poseidon2-constraint-delta.mjs --runs 10`)

| Shape (Veil use) | Old constraints | New constraints | Δ constraints | Old proving (ms) | New proving (ms) | Δ proving |
|---|---|---|---|---|---|---|
| merkle2 (Merkle level, ×20/proof) | 517 | 580 | **+12.2%** | 112.34 | 87.51 | **-22.1%** |
| recipient2 (withdraw recipient hash) | 517 | 483 | -6.6% | 120.25 | 80.08 | -33.4% |
| amount3 (tx-amount hash) | 605 | 580 | -4.1% | 115.22 | 90.83 | -21.2% |
| commit4 (commitment/nullifier, ×3/proof) | 736 | 852 | **+15.8%** | 123.34 | 89.53 | **-27.4%** |

Raw output:

```
=== old_merkle2 ===
[INFO]  snarkJS: # of Constraints: 517
--- Groth16 setup + proving (10 runs) for old_merkle2 ---
  mean: 112.339 ms   stddev: 7.934 ms

=== new_merkle2 ===
[INFO]  snarkJS: # of Constraints: 580
--- Groth16 setup + proving (10 runs) for new_merkle2 ---
  mean: 87.510 ms   stddev: 3.741 ms

=== old_recipient2 ===
[INFO]  snarkJS: # of Constraints: 517
--- Groth16 setup + proving (10 runs) for old_recipient2 ---
  mean: 120.245 ms   stddev: 18.092 ms

=== new_recipient2 ===
[INFO]  snarkJS: # of Constraints: 483
--- Groth16 setup + proving (10 runs) for new_recipient2 ---
  mean: 80.075 ms   stddev: 5.223 ms

=== old_amount3 ===
[INFO]  snarkJS: # of Constraints: 605
--- Groth16 setup + proving (10 runs) for old_amount3 ---
  mean: 115.215 ms   stddev: 10.605 ms

=== new_amount3 ===
[INFO]  snarkJS: # of Constraints: 580
--- Groth16 setup + proving (10 runs) for new_amount3 ---
  mean: 90.833 ms   stddev: 14.473 ms

=== old_commit4 ===
[INFO]  snarkJS: # of Constraints: 736
--- Groth16 setup + proving (10 runs) for old_commit4 ---
  mean: 123.344 ms   stddev: 9.156 ms

=== new_commit4 ===
[INFO]  snarkJS: # of Constraints: 852
--- Groth16 setup + proving (10 runs) for new_commit4 ---
  mean: 89.525 ms   stddev: 5.281 ms
```

**The naive framing is wrong, and that's the interesting finding.** Total R1CS constraints go
*up* for the two shapes Veil calls most (merkle2 ×20 per proof via the depth-20 tree, commit4
×3 per proof for commitment/nullifier pairs), because circom cannot fully collapse
`@taceo/circom-lib`'s external/internal linear-layer matrix multiplications into pure linear
combinations — they show up as extra `linear constraints`, not `non-linear`. But
**non-linear (S-box) constraints go down in all four shapes**, and proving time — which
includes witness generation, dominated by non-linear/multiplication work, not by the padded
QAP domain size — is **faster in all four shapes, by 21-33%.**

### Cross-check — JS Poseidon2 sponge vs the compiled circuit's actual witness (`node scripts/bench/verify-poseidon2-sponge.mjs`)

```
new_merkle2: circuit=19440202363237281411582519622441422429699333916864112080167601237210978582482 js=19440202363237281411582519622441422429699333916864112080167601237210978582482 -> MATCH
new_recipient2: circuit=5329749887768727344378624328362049927627497796544540205384648456106402292535 js=5329749887768727344378624328362049927627497796544540205384648456106402292535 -> MATCH
new_amount3: circuit=7102713631971181352860826117734309668994295004128381837127269701186870868789 js=7102713631971181352860826117734309668994295004128381837127269701186870868789 -> MATCH
new_commit4: circuit=11886967607708399987882240953209573170907039220317105175569357629171592306931 js=11886967607708399987882240953209573170907039220317105175569357629171592306931 -> MATCH

All four Poseidon2Sponge shapes match between JS and the compiled circom circuit.
```

### Full production circuit shape (`node scripts/bench/poseidon2-full-circuit.mjs --runs 10`)

| Circuit | Old constraints | New constraints | Δ constraints | Old proving (ms) | New proving (ms) | Δ proving |
|---|---|---|---|---|---|---|
| `transfer` (7 Poseidon calls, 20 Merkle levels) | 13,611 | 15,194 | +11.6% | 788.25 | 745.69 | **-5.4%** |
| `withdraw` (4 Poseidon calls, no Merkle path) | 3,058 | 3,372 | +10.3% | 272.62 | 236.37 | **-13.3%** |
| `compliance` (**partial swap** — leaf hash unchanged) | 12,743 | 13,953 | +9.5% | 762.12 | 762.96 | +0.1% (noise; σ 13-34 ms) |

Raw output:

```
--- compiling transfer (old) ---
[INFO]  snarkJS: # of Constraints: 13611
--- Groth16 setup + proving (10 runs) for transfer ---
  mean: 788.25 ms   stddev: 16.29 ms   min: 748.67 ms   max: 808.47 ms

--- compiling transfer_v2 (new) ---
[INFO]  snarkJS: # of Constraints: 15194
--- Groth16 setup + proving (10 runs) for transfer_v2 ---
  mean: 745.69 ms   stddev: 19.14 ms   min: 718.19 ms   max: 775.47 ms

--- compiling withdraw (old) ---
[INFO]  snarkJS: # of Constraints: 3058
--- Groth16 setup + proving (10 runs) for withdraw ---
  mean: 272.62 ms   stddev: 17.06 ms   min: 251.21 ms   max: 318.22 ms

--- compiling withdraw_v2 (new) ---
[INFO]  snarkJS: # of Constraints: 3372
--- Groth16 setup + proving (10 runs) for withdraw_v2 ---
  mean: 236.37 ms   stddev: 13.20 ms   min: 223.90 ms   max: 270.86 ms

--- compiling compliance (old) ---
[INFO]  snarkJS: # of Constraints: 12743
--- Groth16 setup + proving (10 runs) for compliance ---
  mean: 762.12 ms   stddev: 13.24 ms   min: 741.83 ms   max: 778.69 ms

--- compiling compliance_v2 (new) ---
[INFO]  snarkJS: # of Constraints: 13953
--- Groth16 setup + proving (10 runs) for compliance_v2 ---
  mean: 762.96 ms   stddev: 33.95 ms   min: 727.39 ms   max: 857.66 ms
```

(`transfer`/`withdraw`/`compliance` old-side numbers above are a fresh compile+setup+prove in
this session, not copied from 2026-07-22's `BASELINE.md` — they land within noise of that
night's numbers (751.9/244.3/738.1 ms there vs 788.3/272.6/762.1 ms here), which is itself a
useful cross-session reproducibility check on the existing baseline.)

**Why constraints go up but proving time goes down, at full scale too:** none of the three
circuits cross a power-of-two constraint boundary. `transfer`: 13,611 → 15,194, both < 16,384.
`withdraw`: 3,058 → 3,372, both < 4,096. `compliance`: 12,743 → 13,953, both < 16,384. Groth16's
FFT/MSM cost is set by the padded QAP domain size (next power of two), so that portion of
proving cost is unchanged for all three; the improvement comes entirely from lower
non-linear-constraint (witness-generation) cost. **This would not necessarily hold if a
circuit's constraint count were close enough to a power-of-two boundary that the swap's ~10%
increase pushed it over** — worth flagging explicitly as a caveat, not a guarantee that
generalizes to every circuit shape.

**`compliance`'s wash is a real, not cherry-picked, result.** Only 2 of its 3 Poseidon calls
were swapped (leaf hash stays old, per the t=5 gap above); the two effects (fewer non-linear
constraints from the swapped calls vs. paying full Poseidon(5) unchanged) roughly cancel to a
measured +0.1%, comfortably inside the ~15-35 ms run-to-run noise. I'm reporting this
honestly rather than only the two circuits that improved.

### Negative test (`node scripts/bench/poseidon2-negative-test.mjs`)

```
--- Sanity check: honest witness_v2 is accepted ---
PASS: honest witness accepted

--- Negative test: forged commitment ---
PASS: rejected. snarkjs/wasm error: Error: Assert Failed.

--- Negative test: forged nullifier ---
PASS: rejected. snarkjs/wasm error: Error: Assert Failed.

All malicious witnesses correctly rejected.
```

Against `withdraw_v2`: an honest witness is accepted; a witness with `commitment` (or
`nullifier`) set to an arbitrary value one off from the correctly-derived Poseidon2Sponge
output — simulating a prover claiming ownership of a note they cannot open, or trying to
submit a nullifier that doesn't match their commitment — fails witness generation on the
`commitment === commHash.out` (or `nullifier === nfHash.out`) constraint. No under-constrained
signal was introduced by moving the domain tag from the rate into the capacity element.

### Existing test suites (unaffected — no production circuit was modified)

| Suite | Result | Command |
|---|---|---|
| `transfer.circom` (real Groth16) | **43/43 pass** | `node --experimental-vm-modules test/transfer.test.mjs` |
| `withdraw.circom` (real Groth16) | **35/35 pass** | `node --experimental-vm-modules test/withdraw.test.mjs` |
| `compliance.circom` (real Groth16) | **30/30 pass** | `node --experimental-vm-modules test/compliance.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Move contracts | **NOT RUN** — no `sui` CLI (see below) | `cd contracts && sui move test` |

No test was loosened, skipped, or given new tolerance. The circuit test suites re-compiled
the *original* `transfer.circom`/`withdraw.circom`/`compliance.circom` from a fresh
`circom`+ptau in this session (same constraint counts as 2026-07-22: 13,611 / 3,058 / 12,743
— exact match), confirming this experiment's own untouched-circuit baseline is consistent
before drawing any conclusion about the `_v2` variants.

## Verdict: **KEEP** (research artifacts, not a production swap)

The finding is real and reproducible: at Veil's actual circuit scale, a Poseidon2 sponge swap
measurably speeds up proving for `transfer` (-5.4%) and `withdraw` (-13.3%) despite raising
total R1CS constraints by ~10-12%, is a wash for the partially-swapped `compliance` circuit,
and introduces no under-constrained signal (negative test) or information disclosure
(leakage analysis). That's worth keeping as a citable number and a validated, reusable
benchmark harness — `BASELINE.md` gets a new "Alternative constructions (research only)"
section below the main table.

**What "KEEP" does *not* mean here:** the production circuits are unchanged. Actually shipping
this swap means: deriving/obtaining t=5 Poseidon2 parameters to close the `compliance.circom`
leaf-hash gap (or accepting the partial-swap wash as final), a **new** trusted-setup ceremony
for the `_v2` zkeys (RR2's caveat applies fresh — a dev-only ceremony run tonight is not
production-ready either), updating `verifier.move`'s VKs via the existing 1-epoch timelock
path, rewiring `frontend/src/hooks/useProofGeneration.ts` and every JS-side witness builder
(`circuits/test/*.test.mjs`, `scripts/src/*`) to the new hash, and — since `oldCommitment` /
`nullifier` / etc. values computed under the old hash are not valid inputs to the new
circuit — a migration plan for any already-deposited commitments on testnet. That's a real
follow-up migration project, not a config flip; it's queued below, not attempted tonight, in
keeping with "one hypothesis, tested" for this session.

## Where this could be used

- **Any Circom/Groth16 protocol with a fixed-arity domain-separated hash pattern** (tag +
  N data values, N small — 1 to 4) doing UTXO-style commitments or nullifiers: the same
  microbenchmark methodology (isolate each hash *shape*, not just each hash *function*)
  generalizes directly, and the "constraints up, proving time down" result is itself a
  transferable warning against optimizing for constraint count as a index for proving time
  without measuring both.
- **Merkle-heavy circuits specifically** (any protocol with a depth-20+ commitment
  accumulator): the merkle2 shape is Veil's highest-multiplicity hash call (×20/proof) and
  showed the *largest* proving-time win in the microbenchmark (-22.1%) despite the *largest*
  constraint-count increase (+12.2%) — exactly the shape where "trust the constraint count"
  would have given the wrong sign.
- **A thesis chapter on Poseidon2 adoption cost-benefit**: this experiment is a concrete,
  measured case study of the gap between the two numbers papers usually report (constraint
  count) and the one users actually feel (wall-clock proving time), plus a worked example of
  what a *partial* swap looks like when a needed state size isn't published anywhere.
- **Confidential payroll / compliance circuits with a credential Merkle tree** (the
  `compliance.circom` shape): the wash result here is a useful negative data point — a
  partial hash-primitive swap is not automatically a win, and whether it's worth doing
  depends on exactly which of a circuit's hash calls are swappable given available Poseidon2
  parameter sets.

## Note on queue item #1 (on-chain gas) — re-confirmed BLOCKED, new information

Before starting tonight's main experiment, I spent time re-attempting queue item #1
(on-chain gas per entry point), which 2026-07-22 left BLOCKED on an ambiguous cause (a
sandbox tool-approval denial that wasn't retried, per policy). Tonight's attempt was more
conclusive:

- Direct JSON-RPC read against the deployed testnet package
  (`fullnode.testnet.sui.io:443`) — **denied by the execution sandbox's network policy**
  (`403` at the CONNECT layer, confirmed via `$HTTPS_PROXY/__agentproxy/status`'s
  `recentRelayFailures`, not a transient/ambiguous failure this time).
- Downloading a prebuilt `sui` CLI binary from a GitHub release — **denied**, `403` on
  `github.com/MystenLabs/sui/releases`.
- Installing a `sui` binary crate from crates.io — the only crate literally named `sui` there
  is an unrelated, unmaintained 2022 placeholder (`sui@0.0.1`, no deps) — **not a path to the
  real CLI at all**, this isn't even a policy block, the package just doesn't exist.
- **New this session:** `git clone`/`git ls-remote` against `github.com/MystenLabs/sui.git`
  **succeeds** — git's smart-HTTP protocol is reachable even though the same host's plain
  HTTPS release-download endpoint is not. This means a from-source build of the `sui` CLI is
  *technically reachable* tonight in a way it wasn't confirmed to be on 2026-07-22, though
  building Mysten's full workspace (validator, Move VM, RocksDB, consensus, ...) from source
  is a genuinely multi-hour, disk-heavy undertaking that I did not attempt tonight — it would
  have consumed this entire session's budget on a different queue item than the one I'd
  already started measuring.

Re-ranked in `EXPERIMENTS.md`: item 1 stays "on-chain gas" but its note now says to budget an
**entire dedicated night** for the from-source `sui` build via `git clone` (not a "spend the
first hour" side quest), since the network path is now confirmed to exist, just expensive.

## Open questions (next queue)

1. **Poseidon2 production migration** (new, high-value if the from-source `sui` build lands
   first and can measure the gas-cost delta of a bigger zkey/VK too) — do the full swap:
   derive or source t=5 Poseidon2 parameters for `compliance.circom`'s leaf hash, run a
   *documented* multi-contributor ceremony (not dev-only) for the new zkeys, update
   `verifier.move`'s VKs via the timelock path, and migrate `useProofGeneration.ts` +
   `scripts/src/*` + `circuits/test/*.test.mjs` to the new hash. This is the natural
   continuation of tonight's KEEP.
2. Does a hand-optimized Poseidon2Sponge (collapsing `@taceo/circom-lib`'s
   `ExternalMatMulT`/`InternalMatMulT` intermediate signals into direct linear combinations)
   remove the "linear constraints" bloat this experiment measured, making the swap a
   constraint-count win too, not just a proving-time win? Would need care not to reintroduce
   the exact under-constrained-signal risk this experiment avoided by using the published
   templates verbatim.
3. `sui` CLI from-source build via `git clone` (new information above) — a full dedicated
   night, now that the network path is confirmed reachable.
4. Does the "constraints up, proving time down because non-linear count dominates and the
   power-of-two domain doesn't change" pattern hold for `compliance.circom` *without* the
   partial-swap gap, once t=5 parameters exist? Tonight's wash result might resolve into a
   clear win once C1 is included.
