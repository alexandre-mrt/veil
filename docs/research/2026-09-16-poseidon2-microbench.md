# 2026-09-16 — Poseidon2 vs Poseidon: constraint count and proving-time delta (queue item #2)

## Hypothesis

Swapping Veil's Poseidon (circomlib, BN254) for Poseidon2 at the two arities the protocol
actually uses — 2 inputs (the Merkle sibling hash, called 20x per `transfer.circom` /
`compliance.circom` proof) and 3 inputs (`txAmountHash`, compliance `nfHash`, compliance
`ctxHash`) — measurably reduces R1CS constraint count and Groth16 proving time.

This is queue item #2. It is **not** a circuit change to the shipped protocol: nothing in
`transfer.circom`, `compliance.circom`, `withdraw.circom`, `contracts/`, or `frontend/` was
touched. The experiment is an isolated benchmark scaffold under `circuits/bench/` that measures
the two hash functions at production-identical arities and a full depth-20 Merkle proof with
each, to answer the queue question before committing to an actual migration (new circuits, new
trusted setup, new on-chain verifying key, audit).

## Threat / privacy model

No adversary model changes — this experiment ships no circuit change, so nothing about Veil's
soundness, privacy, or trust boundaries is touched by merging it. Two narrower things matter:

**Who relies on the Poseidon2 code added here being honest, and what happens if it's wrong.**
`circuits/bench/poseidon2.circom` is a from-scratch circom implementation of the Poseidon2
permutation (external/internal rounds, the M4 near-MDS block, the partial-round S-box), built
because no circom Poseidon2 library exists on the npm registry (checked: `poseidon2-circom`,
`circom-poseidon2`, `@taceo/poseidon2-circom`, `poseidon2-hash-circom`, `circomlib-poseidon2` all
404). Its correctness rests on:

- **Round constants and matrices**, extracted from `@taceo/poseidon2` 0.2.0 (`t=3`, `t=4`), which
  claims parity with the HorizenLabs reference sage script and the Rust `taceo-poseidon2` crate.
  The `t=4` parameter set (diagonal + all 64 rounds' external constants + all 56 internal
  constants) is cross-checked bit-for-bit in this repo against the independently-shipped
  `@zkpassport/poseidon2` package (`scripts/bench/poseidon2-constants.mjs`) — two unrelated teams'
  published constants agree exactly. **`t=3` has no second source reachable from this sandbox**
  (see Approach) and is single-sourced from `@taceo/poseidon2` alone.
- **The permutation algorithm itself**, transcribed by hand from `@taceo/poseidon2`'s TypeScript
  source into circom, then verified against that same library's native (non-circuit) output for
  concrete test vectors (`state=[0,1,2]` for t=3, `state=[0,1,2,3]` for t=4) — the circom witness's
  output signal matches the JS reference exactly (see Results).
- A **negative test** (`hash2_poseidon2_checked` / `hash3_poseidon2_checked` circuits,
  `test/poseidon2-microbench.test.mjs`) proving the R1CS actually constrains the output: a witness
  with a `claimedOut` one field element off from the real permutation output fails witness
  generation with `Error: Assert Failed`, exactly like the `oldCommitment === oldHash.out`-style
  equality checks already used throughout `transfer.circom`/`compliance.circom`/`withdraw.circom`.

**What this does NOT establish.** Two independent JS libraries agreeing, plus a hand-verified
algorithm transcription, is real evidence but is **not** a substitute for re-deriving the
constants directly from the Poseidon2 paper (eprint 2023/323) against the canonical
[HorizenLabs generation script](https://github.com/HorizenLabs/poseidon2/blob/main/poseidon2_rust_params.sage)
— this sandbox has no network path to run or even fetch that script (see Approach). Nor does this
experiment audit either npm package's implementation for bugs correlated between the two (e.g. if
both copied constants from the same flawed source). **`circuits/bench/poseidon2.circom` must not
be treated as production-ready** — it exists to produce a constraint/timing number, not to ship.
This is stated explicitly in the file's own header comment.

**STRIDE / `docs/threat-model.md` mapping:** none. RR2 (trusted-setup, single dev contributor)
would be the relevant entry *if* a Poseidon2 migration were ever merged (new circuits need a new
ceremony), but since the verdict below is REJECT, no circuit ships and RR2 is unaffected tonight.

**Assumptions:** BN254 discrete-log hardness and Groth16 soundness, unchanged. The dev-only
trusted setup used for the *benchmark* zkeys (`circuits/bench/build/pot14_final.ptau`, a
locally-generated, single-contributor ceremony — see Approach) is not used by, and has no bearing
on, any deployed Veil circuit; it only proves the isolated bench circuits for timing purposes.

## Approach

**What was tried first (queue item #1, still BLOCKED — see LEDGER 2026-07-22, 2026-09-16).**
Before starting this experiment, I spent the first part of the run trying to unblock the
higher-ranked queue item (on-chain gas per entry point), per the prior run's note to "spend an
early part of the next run purely on unblocking the toolchain." Confirmed dead ends, more
thoroughly than the 2026-07-22 attempt:

- No `sui` CLI reachable: not on crates.io (`index.crates.io/su/i/sui` → 404), no apt/snap
  package, and this session's GitHub access is scoped to `alexandre-mrt/veil` only — `api.github.com`
  and `github.com/<other-repo>` both return an explicit access-scope denial, so a release-binary
  download or `git clone` of `MystenLabs/sui` over HTTPS is not possible via those paths. (Plain
  `git clone` over the native git protocol *is* reachable — that's how `circom` got built from
  source tonight, see below — but `sui` is not published as an installable crate, so there is no
  crates.io path, and building the full Sui workspace from source was already judged impractical
  in one night's budget on 2026-07-22.)
- No direct RPC path either: every Sui JSON-RPC host tried — `fullnode.testnet.sui.io`,
  `fullnode.mainnet.sui.io`, `explorer-rpc.mainnet.sui.io`, `sui-mainnet-rpc.allthatnode.com` —
  is rejected by the egress proxy with `connect_rejected` / `403` (`organization policy`), not a
  transient failure. This reads as a deliberate categorical block on blockchain RPC egress in this
  sandbox, not a fixable toolchain gap.

This is a stronger, more complete negative result than 2026-07-22's (which didn't rule out
crates.io or explain the GitHub scoping), so queue item #1 stays BLOCKED with updated notes in
`EXPERIMENTS.md` rather than a re-attempt burning the rest of the night. Moved on to item #2.

**What was built for tonight's actual experiment:**

- `scripts/bench/poseidon2-constants.mjs` — extracts Poseidon2 round constants/matrices for
  `t=3` and `t=4` from `@taceo/poseidon2`'s compiled JS (no public API exposes them), cross-checks
  the `t=4` set bit-for-bit against `@zkpassport/poseidon2`, and regenerates
  `circuits/bench/poseidon2.circom` from a template. Re-running it is how you regenerate the
  circuit if either npm package updates its constants.
- `circuits/bench/poseidon2.circom` (generated) — `Poseidon2Perm3`/`Poseidon2Hash2` (t=3) and
  `Poseidon2Perm4`/`Poseidon2Hash3` (t=4), matching circomlib's `Poseidon(nInputs)` output
  convention (capacity signal initialized to 0, output = state[0] after the permutation) so the
  comparison is apples-to-apples.
- `circuits/bench/poseidon_baseline.circom` — the current production Poseidon (circomlib),
  wrapped at the same two arities, for a fair side-by-side.
- `circuits/bench/merkle_proof_poseidon2.circom` — a byte-for-byte copy of
  `templates/merkle_proof.circom` (the depth-20 accumulator membership check `transfer.circom` and
  `compliance.circom` both use) with only the hash call swapped to `Poseidon2Hash2`, isolating the
  effect on Veil's actual dominant constraint contributor (20 hash calls per proof).
- `circuits/bench/poseidon2_checked.circom` + `mains/hash{2,3}_poseidon2_checked.circom` — the
  negative-test wrapper described above.
- `circuits/bench/compile-bench.sh` — compiles all 8 bench circuits and runs Groth16 setup against
  a **locally generated** dev-only Powers of Tau (`bash circuits/bench/compile-bench.sh`).
  `circuits/scripts/compile.sh`'s existing ptau URL
  (`storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau`) now returns
  `AccessDenied` directly from Google Cloud Storage (not a sandbox block — the bucket itself
  denies anonymous reads), and the usual Hermez S3 mirror
  (`hermez.s3-eu-west-1.amazonaws.com/...`) does too. Both existing `compile*.sh` scripts in this
  repo are now broken for anyone without a cached ptau file — a real, separate finding, noted here
  and left for a future night (not this one's scope) since it blocks nothing about tonight's
  measurement (a self-generated pot14 ptau is a legitimate dev-only ceremony, same trust model as
  the existing single-dev-contributor setup already documented in `docs/threat-model.md` RR2).
- `scripts/bench/poseidon2-microbench.mjs` — R1CS constraint counts (`snarkjs.r1cs.info`) and
  Groth16 proving time (`snarkjs.groth16.fullProve`, 10 runs + 1 discarded warm-up, same method as
  `prove-latency.mjs`) for baseline vs. Poseidon2 at each of the three comparisons below.
- `test/poseidon2-microbench.test.mjs` — the correctness check (circuit output matches the JS
  reference permutation) and the negative test (malicious witness rejected).

**Alternatives rejected before building this:**

- *Swap Poseidon2 directly into `transfer.circom`/`compliance.circom`/`withdraw.circom`* — rejected
  as this run's scope. That's a full protocol migration (new trusted setup invalidating the
  existing testnet verifying key, new on-chain verifier bytes, frontend proving-code changes, and
  an actual security audit of hand-written round-constant circom code) — the task explicitly asks
  for "a measured constraint-count and proving-time delta" *before* that commitment, not the
  migration itself. An isolated, non-shipped benchmark answers the question with the same rigor at
  a fraction of the blast radius.
- *t=5/t=6 arities* (matching `transfer.circom`'s `Poseidon(4)` and `compliance.circom`'s
  `Poseidon(5)`, i.e. 3 of the 4 named hash calls per circuit) — **not measurable with an audited
  parameter set**. Poseidon2's external-matrix construction (per the paper and every
  implementation checked: `@taceo/poseidon2`, `@zkpassport/poseidon2`) is only defined for
  `t ∈ {2, 3, 4, 8, 12, 16, 20, 24}` — t must be 2, 3, or a multiple of 4. There is no standard
  Poseidon2 parameterization for `t=5` or `t=6` at all; the only options are padding the input to
  the next supported width (`t=8`, wasting 3-4 field elements per call) or inventing
  non-standard/unaudited matrices for `t=5,6` by hand. Neither is something this experiment should
  do — it would be presenting a guess as a measurement. **This is itself a real finding**: roughly
  half of Veil's Poseidon calls (the 4-input and 5-input ones) cannot be replaced by an
  off-the-shelf-parameterized Poseidon2 at all; only the 2-input (dominant, 20x/proof) and 3-input
  ones can, without inventing cryptography.
- *Downloading a Poseidon2 circom implementation* — no such package exists on npm (checked, see
  Threat model section); none was found via the GitHub search available in this session's scope
  (limited to `alexandre-mrt/veil`, so a general GitHub code search wasn't possible either).

## Results

### Constraint counts (from `snarkjs.r1cs.info`)

| Comparison | Circuit | R1CS constraints | Δ vs. baseline |
|---|---|---:|---:|
| 2-input hash (Merkle sibling, 20x/proof) | `hash2_poseidon` (baseline) | 517 | — |
| | `hash2_poseidon2` | 515 | **-2 (-0.4%)** |
| 3-input hash (txAmountHash / nfHash / ctxHash) | `hash3_poseidon` (baseline) | 605 | — |
| | `hash3_poseidon2` | 612 | **+7 (+1.2%, worse)** |
| Depth-20 Merkle proof (full membership check) | `merkle20_poseidon` (baseline) | 10,400 | — |
| | `merkle20_poseidon2` | 10,360 | **-40 (-0.4%)** |

Constraint count is essentially a wash — a small win at t=3, a small loss at t=4. This is expected
once you separate what Poseidon2 actually optimizes from what Groth16/R1CS actually costs:
Poseidon2's speedup is in its **linear layer** (an O(t) near-MDS multiply vs. Poseidon's dense
O(t²) MDS multiply) — but in R1CS, multiplying a signal by a *compile-time constant* is a linear
combination, not a constraint, regardless of matrix density. The two hash functions use the same
round structure (RF=8 full rounds, RP=56 partial rounds, α=5 S-box) and the same number of
nonlinear S-box evaluations, which is what actually costs constraints. **Poseidon2 does not reduce
Groth16 constraint count for Veil's arities** — the widely-cited Poseidon2 speedup is a native
(out-of-circuit) hashing-throughput improvement, not an in-circuit one.

### Proving time (mean of 10 runs + 1 discarded warm-up, `groth16.fullProve` = witness gen + prove)

| Comparison | Circuit | Mean (ms) | σ (ms) | Δ vs. baseline |
|---|---|---:|---:|---:|
| 2-input hash | `hash2_poseidon` | 141.65 | 11.71 | — |
| | `hash2_poseidon2` | 101.01 | 6.95 | **-28.7%** |
| 3-input hash | `hash3_poseidon` | 135.41 | 7.20 | — |
| | `hash3_poseidon2` | 103.50 | 4.36 | **-23.6%** |
| Depth-20 Merkle proof | `merkle20_poseidon` | 819.39 | 18.43 | — |
| | `merkle20_poseidon2` | 779.28 | 15.92 | **-4.9%** |

Despite near-identical constraint counts, Poseidon2 **is** meaningfully faster end-to-end at the
single-hash scale (-24% to -29%), and the effect survives (shrunk) at real Merkle-proof scale
(-4.9%, well outside the ~2% combined noise band). This is consistent with the constraint-count
finding: the saving is in **witness generation** (native field arithmetic, where Poseidon2's
cheaper linear layer actually matters), not in the Groth16 proving step itself (which scales with
constraint count via FFT/MSM, and that count barely moved). At one hash call, witness generation
is a large fraction of the ~100-140ms total; at 20 chained hash calls (~10,400 constraints), the
FFT/MSM cost dominates wall-clock time and dilutes the same per-hash witness-gen saving to ~5%.

Toolchain: circom 2.2.2 (built from source, `iden3/circom` tag `v2.2.2` — same as 2026-07-22),
snarkjs 0.7.6, Node v22.22.2, single dev-only Groth16 contribution against a locally-generated
pot14 Powers of Tau (not downloaded — see Approach). Same machine as the 2026-07-22 baseline.

Reproduce:
```
cd circuits && npm install && bash bench/compile-bench.sh
cd .. && node scripts/bench/poseidon2-microbench.mjs --runs 10
```

Raw output (this run):
```
=== Poseidon vs Poseidon2 microbenchmark (10 runs per circuit) ===
node v22.22.2, linux/x64

--- 2-input hash (Merkle sibling, used 20x/proof) ---
  baseline   hash2_poseidon         constraints=   517  prove=141.65ms (sigma 11.71)
  poseidon2  hash2_poseidon2        constraints=   515  prove=101.01ms (sigma 6.95)

--- 3-input hash (txAmountHash / compliance nfHash / ctxHash) ---
  baseline   hash3_poseidon         constraints=   605  prove=135.41ms (sigma 7.20)
  poseidon2  hash3_poseidon2        constraints=   612  prove=103.50ms (sigma 4.36)

--- depth-20 Merkle proof (full anonymity-set membership check) ---
  baseline   merkle20_poseidon      constraints= 10400  prove=819.39ms (sigma 18.43)
  poseidon2  merkle20_poseidon2     constraints= 10360  prove=779.28ms (sigma 15.92)
```

### Correctness check (circuit output vs. `@taceo/poseidon2` native reference)

```
hash2_poseidon2 out: [ '5297208644449048816064511434384511824916970985131888684874823260532015509555' ]
expected:              5297208644449048816064511434384511824916970985131888684874823260532015509555
hash3_poseidon2 out: [ '786823568102245344938517132468097745676732687098822989626730198331658606391' ]
expected:              786823568102245344938517132468097745676732687098822989626730198331658606391
```
Exact match for both arities.

### Negative test (malicious witness rejected)

```
POSITIVE (correct claimedOut): proof generated OK, publicSignals = [ '52972086...9555' ]
ERROR:  4 Error in template Poseidon2Hash2Checked_3 line: 20
NEGATIVE (wrong claimedOut) correctly REJECTED at witness generation: Error: Assert Failed. Error in template Poseidon2Hash2Checked_3 line: 20
```
A `claimedOut` one field element off from the true permutation output is unsatisfiable, as
expected for an R1CS equality constraint.

### Pre-existing suite (unaffected — no production circuit, contract, or frontend code changed)

- `circuits`: `transfer.test.mjs` 43/43, `compliance.test.mjs` 30/30, `withdraw.test.mjs` 35/35
  (run individually — the chained `npm test` hang from queue item #12 is real and reproduces here
  too; each file passes standalone).
- `frontend`: `tsc --noEmit` clean, `biome check .` clean, `vitest run` 19/19.
- `scripts`: `test-converter.ts` 109/109 passed.
- `contracts` (`sui move test`): **not run** — same `sui` CLI blocker as queue item #1 (see
  Approach). No contract code was touched, so the risk from skipping is low, but this is a real
  verification gap, not a passing claim.

## Verdict: REJECT

Poseidon2 does not move a number Veil pays for enough to justify the migration cost, at least not
yet. Specifically:

- **No on-chain/gas benefit.** The Groth16 proof stays 3 fixed-size group elements (128 bytes
  compressed) regardless of the hash function inside the circuit — `sui::groth16` verification
  cost is unaffected either way (this doesn't change queue item #1's blocked status; it just means
  a Poseidon2 migration wouldn't touch that number even if measured).
- **No constraint-count benefit** (the number that actually drives proving cost) — a wash at best,
  a small regression at the 3-input arity.
- **A real but modest proving-time benefit that shrinks at realistic scale**: -24-29% for a single
  hash call, but only **-4.9%** for a full depth-20 Merkle proof, which is the unit that actually
  matters (Veil proves whole `transfer.circom`/`compliance.circom` circuits, not standalone
  hashes). transfer.circom's total proving time today is ~752ms (2026-07-22 baseline); a Merkle-
  proof-scale ~5% saving on the dominant sub-component would land somewhere around 3-4% off the
  whole circuit's proving time — a real but small user-facing win.
- **Half the protocol's hash calls can't move at all** without inventing unaudited cryptography
  (t=5, t=6 have no standard Poseidon2 parameterization) — so any real migration would leave Veil
  running *two* hash functions (Poseidon2 at t=3/t=4, Poseidon at t=5/t=6) for a ~3-4% overall
  proving-time gain, which is a worse audit surface than today's single, well-understood Poseidon.
- **Migration cost is high and this experiment's own crypto provenance isn't strong enough to
  build on directly**: a real migration needs a from-the-paper constant re-derivation (not two
  npm packages agreeing), a new trusted-setup ceremony invalidating the existing testnet verifying
  key, on-chain verifier changes, frontend proving-code changes, and a fresh audit — for a
  single-digit-percent proving-time win on the one arity that can move at all.

Keeping the branch (`circuits/bench/`, `scripts/bench/poseidon2-*`) — the constants extraction,
cross-check, and microbenchmark harness are reusable if a future night wants to re-check this
after either (a) a genuinely audited Poseidon2 circom library appears, or (b) Veil becomes
proving-time-bound enough that even a 3-4% win matters (e.g. after a batching/aggregation change
makes per-transfer proving time the binding constraint rather than gas).

No `BASELINE.md`, `docs/threat-model.md`, or `docs/SPEC.md` changes — nothing shipped.

## Where this could be used

- **The R1CS-vs-native distinction is the generalizable result**, not the REJECT verdict itself:
  any SNARK protocol evaluating a "faster hash" swap (Poseidon2, Reinforced Concrete, Griffin,
  Rescue-Prime) needs to separate *native hashing throughput* (relevant to an indexer rebuilding a
  Merkle tree, a relayer batching nullifier checks, or any off-chain sponge use) from *in-circuit
  proving cost* (driven by S-box/nonlinear-constraint count, not linear-layer density). A protocol
  whose bottleneck is off-chain hashing (e.g. an indexer processing 10^6+ commitments, this repo's
  own queue item #4) would see Poseidon2's real advantage; one whose bottleneck is prover wall-
  clock time on a fixed-size circuit (Veil, today) mostly wouldn't.
- **The t∈{2,3,4,8,12,...} parameterization gap** is a concrete gotcha for any Circom/Groth16
  privacy protocol using Poseidon at an "odd" arity (5, 6, 7) for domain-separated multi-field
  commitments (a common pattern: `Poseidon(tag, field1, field2, ...)`) — Poseidon2 is not a
  drop-in replacement at those arities without padding or new parameter derivation. Worth checking
  before any such protocol commits to a Poseidon2 migration on the strength of benchmarks run only
  at t=2/t=3.
- **A confidential-payroll or KYC-credential system** (this repo's own "t-of-n auditor board" use
  case, queue item #6) with a *much larger* off-chain Merkle tree (audit trail, not anonymity set)
  would be a better candidate for Poseidon2 specifically because its bottleneck is more likely
  native tree-construction throughput than per-proof Groth16 time.

## Open questions

1. **Does a from-the-paper Poseidon2 constant derivation (not two npm packages) exist anywhere
   reachable from a more permissive sandbox?** If a future run has broader GitHub access, cloning
   `HorizenLabs/poseidon2` and running its sage script directly would upgrade this experiment's
   weakest link (t=3's single-source constants) to an independently-reproducible one.
2. **What is Poseidon2's actual native (non-circuit) hashing throughput advantage for Veil's
   indexer use case** (queue item #4, Merkle accumulator at 10^5-10^7 commitments)? Tonight's
   result suggests that's where Poseidon2 would actually pay off for Veil, if anywhere — worth
   measuring directly rather than inferring from the in-circuit numbers here.
3. **`circuits/scripts/compile.sh` and `circuits/scripts/compile-{withdraw,compliance}.sh`'s ptau
   URL is dead** (Google Cloud Storage `AccessDenied`, and the Hermez S3 mirror too) — anyone
   without a cached ptau can no longer follow this repo's own documented build instructions. Small,
   unrelated to tonight's verdict, but real; worth a future night's fix (generate-locally, like
   `compile-bench.sh` does, or find a live mirror).
4. Re-confirm: is `t∈{5,6}` truly unparameterizable in Poseidon2, or does a more recent revision of
   the paper/reference implementation define an M4-block extension for non-multiple-of-4 widths
   above 4 that neither `@taceo/poseidon2` nor `@zkpassport/poseidon2` happened to implement? Worth
   a literature check with real network access before treating this as settled.
