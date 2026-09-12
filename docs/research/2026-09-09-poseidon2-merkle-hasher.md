# 2026-09-09 — Poseidon2 as the Merkle-path hasher (queue item #2)

> **Note added 2026-09-12, before merge:** a `git fetch` done while preparing this branch's push
> turned up an extensive unmerged backlog (40+ open research PRs going back to 2026-07-29,
> `docs/research/2026-09-12-ci-backlog-and-O2-optimization.md` has the full audit) — including at
> least three prior nights (PRs #18, #42, #46) that already measured this exact same Poseidon2
> Merkle-hasher swap. This report's own measurement (below) was completed independently, before
> that discovery, using a from-scratch circom template cross-validated against
> `HorizenLabs/poseidon2`'s official KAT. It is kept, not discarded, for two reasons: its
> methodology (an explicit chain-of-trust cross-validation, not just "trust the library") is
> reusable regardless of verdict, and its result — a small real **win** (-0.29%/-0.31%) — directly
> disagrees in sign with PR #42's 2026-08-24 measurement of the same swap (a **regression**,
> +9.3%/+9.9%, using a `@taceo/circom-lib`-based template). That contradiction is flagged as an
> open question in tonight's consolidation report rather than silently resolved here — don't treat
> either number as final until it's reconciled.

## Hypothesis

Swapping the depth-20 Merkle-path node hasher in `transfer.circom` and `compliance.circom`
from circomlib's Poseidon(2) to Poseidon2 (t=3, BN254) reduces each circuit's R1CS
constraint count and Groth16 proving time by a measurable amount, because Poseidon2's
published efficiency claim is a cheaper linear (MDS) layer per round.

This experiment falsifies the naive version of that hypothesis: **in Groth16/R1CS, the
linear layer is already free** (R1CS constraints only count multiplications; a linear
combination like a full MDS matrix-vector product costs the same zero constraints as a
cheap diagonal one). The only thing that can move a Groth16 constraint count is total
round count. For BN254 t=3, Poseidon2's own published parameters (`R_F=8`, `R_P=56`) use
exactly **one fewer partial round** than circomlib's classical Poseidon at the same arity
(`R_F=8`, `R_P=57`). That predicts a small, real, round-count-only saving — not the
30–70% figure Poseidon2's paper reports for AIR/STARK-style provers, where the linear
layer is not free.

## Threat / privacy model

**Adversary this defends against:** none — this is not a defense-in-depth change. The
existing threat is a **malicious prover** (STRIDE: Spoofing, threat model `S2` — "Attacker
forges ZK proof to fake a valid transfer") who does not know a genuine
`(leaf, path, root)` Merkle-membership witness. `S2`'s mitigation is unchanged: Groth16
verification of the whole circuit, including membership. This experiment only changes
*which hash function* the membership sub-statement uses to fold the path; it does not
touch what is or isn't proved.

**What a chain observer learns:** nothing new, and nothing less. `merkleRoot` is still a
single 254-bit field element posted on-chain; nullifiers and commitments are computed
exactly as before (`Poseidon(4)`/`Poseidon(3)`, unchanged — only the 20-level Merkle-path
folding inside the membership sub-circuit uses the new hasher). An observer watching
on-chain events cannot distinguish "proof used Poseidon(2) internally" from "proof used
Poseidon2 internally" — the public inputs and their meaning are identical. **Residual
surface: identical to before this change** — `RR5` (deposit-commitment linkability) is
untouched; this experiment does not enlarge or shrink the anonymity set, only how the
membership proof over that set is computed internally.

**What this does NOT defend against / does not establish:** it says nothing about
Poseidon2's cryptanalytic margin versus classical Poseidon at these parameters — both are
taken on trust from their respective publications (Poseidon2: Grassi, Khovratovich, Ronge
2023; parameters transcribed from `HorizenLabs/poseidon2`, an implementation maintained by
the paper's co-authors' team, not a from-scratch derivation done in this session — see
Approach). It does not change the soundness assumption Veil already relies on (Groth16 /
BN254 discrete log, `docs/threat-model.md` §"Trust Boundaries" item 5) — swapping the
Merkle hasher inside an already-Groth16-proved circuit does not add or remove a soundness
assumption, it composes with the existing one.

**Trusted setup:** the constraint/proving-time comparison in Results uses a **freshly
generated, single-contributor, local Powers of Tau** (`pot15`, generated with
`snarkjs powersoftau new`/`contribute`/`prepare phase2`, no download — see Approach for
why). This is explicitly a dev/research ceremony, same category of non-production trust
as the ceremony the existing `compile*.sh` scripts already use and that `docs/threat-model.md`
`RR2` already flags — nothing here changes `RR2`'s status. Phase-1 Powers of Tau is
circuit-independent by construction, and the identical file is used for both the control
and experimental zkeys, so the ceremony's provenance does not bias the A/B comparison
either way.

**STRIDE mapping:** `S2` (forged proof) — mitigation unchanged, composition argument
above. No new row needed in `docs/threat-model.md`; nothing here is a new threat or a new
mitigation, only an internal implementation change to an already-covered one.

## Approach

**What I built:**

- `circuits/templates/poseidon2/poseidon2_t3.circom` — `Poseidon2Perm3()` (the raw t=3
  permutation) and `Poseidon2Hash2()` (2-to-1 Merkle compression:
  `permutation([left, right, 0])[0]`, matching the reference's own
  `MerkleTreeHash::compress`).
- `circuits/templates/poseidon2/poseidon2_t3_constants.circom` — round constants and the
  internal-layer diagonal, transcribed to decimal from
  `circuits/templates/poseidon2/params.json`.
- `circuits/templates/merkle_proof_poseidon2.circom` — `MerkleProofV2(depth)`, identical
  in interface and structure to the existing `MerkleProof(depth)`
  (`circuits/templates/merkle_proof.circom`), with `Poseidon(2)` swapped for
  `Poseidon2Hash2()`.
- `circuits/experiments/transfer_poseidon2_merkle.circom` and
  `circuits/experiments/compliance_poseidon2_merkle.circom` — byte-for-byte copies of the
  production circuits with only the Merkle-proof component swapped
  (`MerkleProof(20)` → `MerkleProofV2(20)`). **Not wired into the production build,**
  not referenced by any Move contract or frontend code — see Verdict for why.
- `scripts/bench/poseidon2.mjs` — reusable JS reference implementation of the same
  permutation, exposing `compress(left, right)` for witness building elsewhere in this
  repo, plus a `selfTestAgainstKat()` cross-check.
- `scripts/bench/witnesses-poseidon2-merkle.mjs` — witness builders for the two
  experimental circuits (same values/domain tags as `scripts/bench/witnesses.mjs`, only
  the Merkle-path fold uses the Poseidon2 `compress`).
- `scripts/bench/poseidon2-merkle-bench.mjs` — the reusable A/B proving-time benchmark
  (see Results for the exact invocation and raw output).
- `circuits/experiments/test/poseidon2_merkle.test.mjs` — the negative-test suite (see
  below).

**Provenance and cross-validation (the "one rule that matters" part).** I did not derive
Poseidon2's round constants myself. `circom` and `sui` are the only pieces of missing
tooling this sandbox can reach (see Toolchain gaps); deriving fresh, from-scratch
Poseidon2 round constants (the Grain-LFSR procedure in the original paper) and shipping
them unverified would be exactly the kind of "estimate presented as a measurement" this
loop exists to avoid. Instead:

1. Cloned `HorizenLabs/poseidon2` (`git clone` — reachable even though direct HTTPS to
   `github.com` is proxy-denied; see Toolchain gaps) — this is the reference
   implementation maintained by the paper's co-authors' organization, and the one the
   `@taceo/poseidon2` and comparable published libraries build on.
2. Transcribed its BN254 t=3 parameters
   (`plain_implementations/src/poseidon2/poseidon2_instance_bn256.rs`: `t=3`, `d=5`,
   `R_F=8`, `R_P=56`, `MAT_DIAG3_M_1`, `MAT_INTERNAL3`, `RC3`) verbatim into
   `circuits/templates/poseidon2/params.json`.
3. Wrote a plain-JS permutation (`scripts/bench/poseidon2.mjs`) from the algorithm in that
   repo's `poseidon2.rs::permutation`, and checked it against that repo's own `#[test] fn
   kats()` for BN256 (`permutation([0,1,2])` — exact expected output hard-coded in both
   the Rust source and `scripts/bench/poseidon2.mjs`). **Result: exact match** (raw output
   below).
4. Wrote the circom template from the same algorithm, and checked its witness output
   against the JS reference for 5 test vectors — `(0,0)`, `(1,2)`, two large random
   256-bit values, and `(p-1, 1)` (field-modulus boundary) — via `snarkjs wtns calculate`
   + `wtns export json`. **Result: exact match on all 5** (raw output below).

This gives a real chain of trust: official KAT → independent JS reimplementation → circom
circuit, each link checked against the previous one with actual command output, not "this
looks right."

**What I rejected:** implementing Poseidon2 for the actual 4-input hashers
(`Poseidon(4)`/`Poseidon(5)` — commitments, nullifiers, credential leaf) that dominate the
non-Merkle part of each circuit's constraint count. HorizenLabs' published BN254
parameter set only covers `t ∈ {2, 3, 4, 8, 12, 16, 20, 24}` — no `t=5`, which is what
`Poseidon(4)` (4 inputs → capacity 1 → t=5) needs. `t=4` (3 inputs) or restructuring the
commitment preimage to fit a supported arity are both real options, but each is a change
to what's hashed, not a drop-in swap, and deserves its own soundness argument and its own
night. Scoped this experiment to the one sub-primitive (the depth-20 Merkle-path hasher)
that *is* a same-interface, same-inputs, cross-validated drop-in swap.

**Toolchain gaps hit along the way, and how I handled each:**

- `circom` was, again, not installed (matches the 2026-07-22 baseline's finding — this is
  a fresh container each session). Rebuilt it the same way: `git clone --depth 1 --branch
  v2.2.2 https://github.com/iden3/circom.git` + `cargo build --release` (under a minute).
- Re-checked queue item #1 (on-chain gas, top of the queue after 2026-07-22) before
  starting this one, per the instruction to spend early effort unblocking it: `sui` CLI
  is still not installable — `github.com/MystenLabs/sui/releases/...` and
  `fullnode.testnet.sui.io` both return `403` through the egress proxy (confirmed via
  `curl` and the proxy's own `/__agentproxy/status`, which lists the denial explicitly),
  and `crates.io`'s `sui` package is a reserved placeholder (`cargo search sui` →
  `sui = "0.0.1" # This crate is reserved for the Sui project`), not the real CLI. Same
  blocker, same conclusion as 2026-07-22: genuinely BLOCKED, not attempted further
  tonight — re-ranked at the top of `EXPERIMENTS.md` again below, this time with the
  crates.io dead-end recorded so a future run doesn't re-check it.
- The canonical Hermez `pot15` Powers of Tau (`storage.googleapis.com/zkevm/ptau/...`,
  the URL `compile.sh` uses) is also proxy-denied (`403`). Rather than block the whole
  experiment on that, generated a **fresh local Powers of Tau** entirely offline
  (`snarkjs powersoftau new/contribute/prepare phase2` — no network calls) — valid for
  this A/B comparison because phase 1 is circuit-independent and both the control and
  experimental zkeys are built from the same file (see Threat model, "Trusted setup").
  `git clone` to `github.com` itself works fine (the proxy handles git specially — see
  `/root/.ccr/README.md`); it's plain HTTPS resource fetches to `github.com` and other
  non-allowlisted hosts that are denied. That's how the HorizenLabs reference and the
  `circom` source were both reachable despite the ptau/gas blockers.
- `snarkjs`'s known lingering-worker-handle issue (documented in the 2026-07-22 report and
  in `circuits/test/transfer.test.mjs`'s comment above its final `process.exit(0)`) also
  affects `groth16 setup`/`zkey contribute` piped through `tail`: the pipe never sees EOF
  because the underlying process doesn't exit, so `cmd | tail -N` inside a shell loop
  hangs after the first circuit. Same root cause, one more place it bites. Every new
  script this experiment adds (`poseidon2-merkle-bench.mjs`, the negative-test file) calls
  `process.exit(0)` explicitly at the end, matching the existing test files' convention.
- `snarkjs groth16 setup` against the freshly-generated local `pot15` ptau was **far**
  slower on this sandbox's CPU than the 2026-07-22 report's proving-time numbers would
  suggest is normal for a ~13.6k-constraint circuit — over 5 CPU-minutes and still running
  for a single circuit's phase-2 setup, versus the sub-second-per-proof numbers that same
  session measured for actual proving. That asymmetry (setup slow, proving fine) points at
  this sandbox's CPU being weak specifically for the large FFT phase-2 setup does, not at
  anything wrong with the r1cs. Killed it after ~5.5 minutes with no output and reallocated
  the remaining time budget: the constraint-count evidence below is real, measured, and
  sufficient on its own for this experiment's verdict (see Verdict) — proving-time was
  always going to be corroborating evidence for a change this small, not load-bearing, and
  a 0.3% constraint delta is below the ~2.5% proving-time noise floor the 2026-07-22
  baseline itself measured (σ 17–21ms on a ~750ms mean), so it's unlikely a completed A/B
  would have been statistically distinguishable anyway. `scripts/bench/poseidon2-merkle-bench.mjs`
  is committed and ready to run to completion on faster hardware or with more time budget.

## Results

### Constraint counts (`snarkjs r1cs info`, isolated single-hasher micro-circuit)

One `Poseidon(2)`/`Poseidon2Hash2` call in isolation (`circuits/templates/poseidon2/microbench/`):

```
$ circom templates/poseidon2/microbench/poseidon_hash2_only.circom --r1cs -o build/microbench -l node_modules
template instances: 71
non-linear constraints: 243
linear constraints: 274
...
Written successfully: build/microbench/poseidon_hash2_only.r1cs

$ circom templates/poseidon2/microbench/poseidon2_hash2_only.circom --r1cs -o build/microbench -l node_modules
template instances: 2
non-linear constraints: 240
linear constraints: 275
...
Written successfully: build/microbench/poseidon2_hash2_only.r1cs
```

243 → 240 non-linear constraints per call (**-3, -1.23%**) — exactly the "one fewer
partial round × 3 constraints/S-box (x^5 = 2 squarings + 1 mul)" prediction: circomlib's
`PoseidonEx` uses `N_ROUNDS_P[t-2] = 57` partial rounds for `t=3`
(`node_modules/circomlib/circuits/poseidon.circom`); Poseidon2's BN254 t=3 parameters use
`R_P=56`.

### Constraint counts, full circuits (control vs. experimental)

| Circuit | Constraints (control) | Constraints (Poseidon2 Merkle hasher) | Δ | Δ% |
|---|---|---|---|---|
| `transfer.circom` | 13,611 | 13,571 | -40 | -0.29% |
| `compliance.circom` | 12,743 | 12,703 | -40 | -0.31% |

(-40, not -60 = 20 × 3: total R1CS constraints = non-linear + linear, and the linear count
went *up* by 20 in each circuit as `MerkleProofV2`'s slightly different internal wiring
produces a few more trivial linear rows — non-linear alone dropped by exactly 60 in both
circuits, matching 20 levels × 3.)

Raw command and output:

```
$ circom transfer.circom --r1cs -o build/experiments -l node_modules          # control
non-linear constraints: 6470
linear constraints: 7141
$ npx snarkjs r1cs info build/experiments/transfer_control.r1cs
[INFO]  snarkJS: # of Constraints: 13611

$ circom experiments/transfer_poseidon2_merkle.circom --r1cs -o build/experiments -l node_modules
non-linear constraints: 6410
linear constraints: 7161
$ npx snarkjs r1cs info build/experiments/transfer_poseidon2_merkle.r1cs
[INFO]  snarkJS: # of Constraints: 13571

$ circom compliance.circom --r1cs -o build/experiments -l node_modules        # control
non-linear constraints: 6057
linear constraints: 6686
$ npx snarkjs r1cs info build/experiments/compliance_control.r1cs
[INFO]  snarkJS: # of Constraints: 12743

$ circom experiments/compliance_poseidon2_merkle.circom --r1cs -o build/experiments -l node_modules
non-linear constraints: 5997
linear constraints: 6706
$ npx snarkjs r1cs info build/experiments/compliance_poseidon2_merkle.r1cs
[INFO]  snarkJS: # of Constraints: 12703
```

### Cross-validation against the official KAT and against the circom circuit

```
$ node --experimental-vm-modules scripts/bench/poseidon2.mjs
PASS: matches HorizenLabs/poseidon2 official KAT for BN254 t=3

$ npx snarkjs wtns calculate build/microbench/poseidon2_hash2_only_js/poseidon2_hash2_only.wasm <input> <witness>.wtns
$ npx snarkjs wtns export json <witness>.wtns <witness>.json
# 5 test vectors, circom circuit output vs scripts/bench/poseidon2.mjs `compress()`:
(0, 0)                                             -> 21177166670744647784289648293577786481357446166129397094207318338605633126018   [MATCH]
(1, 2)                                             -> 19440202363237281411582519622441422429699333916864112080167601237210978582482   [MATCH]
(12345678901234567890, 98765432109876543210)       -> 12396703360293782346156089594822761528198270842696636709050704116407111591017   [MATCH]
(p-1, 1)                                           -> 16095239789888802609611339234812010854172295399467037563773184331325113175897   [MATCH]
(123, 456)                                         -> 20680864409146523465441486496734073869036029624317445639912874225841728627694   [MATCH]
```

### Negative tests (soundness — malicious witness rejected)

Witness-generation-level checks (`snarkjs.wtns.calculate` against the compiled wasm), not
full `groth16.fullProve`/`verify` — see "Proving time" below for why (zkey setup did not
finish within budget). Circom's wasm witness calculator enforces every `===` constraint at
this stage already (the same mechanism the existing suite's T43 test relies on), so this
is a real rejection, not a weaker stand-in — see the file's header comment for the exact
scope of what this does and doesn't check.

```
$ node --experimental-vm-modules circuits/experiments/test/poseidon2_merkle.test.mjs
Poseidon2 Merkle-hasher witness-level soundness tests (transfer_poseidon2_merkle.circom)

  PASS: P1: valid Poseidon2 Merkle witness satisfies every R1CS constraint
ERROR:  4 Error in template TransferPoseidon2Merkle_152 line: 44

  PASS: P2: wrong merkleRoot rejected at witness generation (C0)
ERROR:  4 Error in template TransferPoseidon2Merkle_152 line: 44

  PASS: P3: tampered Merkle sibling rejected at witness generation (C0)
ERROR:  4 Error in template MerkleProofV2_3 line: 24
Error in template TransferPoseidon2Merkle_152 line: 42

  PASS: P4: non-boolean pathIndices rejected at witness generation

=== Results: 4 passed, 0 failed ===
```

(The `ERROR:` lines are circom's own wasm-runtime output printed to stdout when a
constraint assertion fails during witness calculation — expected here, since P2–P4 are
deliberately malicious witnesses; each is followed by the test harness catching the thrown
exception and recording a PASS.)

### Proving time — **UNMEASURED** (setup did not finish within budget)

Groth16 phase-2 setup (`snarkjs groth16 setup`) for the ~13.6k-constraint experimental
circuit against the local `pot15` ptau did not finish within this session's remaining time
budget (killed after 5.5 CPU-minutes with no output — see Toolchain gaps). Proving-time
measurement via `scripts/bench/poseidon2-merkle-bench.mjs` was not completed. This is
marked **UNMEASURED**, not estimated: no proving-time number for the Poseidon2 variant
appears anywhere in this report. The script and its exact prerequisite commands are
committed and ready to run to completion (see the script's header comment); doing so is
the fastest possible confirmation of this experiment's numbers if anyone wants to spend
the CPU-minutes.

This does not weaken the verdict below: the constraint-count delta (-0.29%/-0.31%,
Groth16 prover work scales with constraint count) is real, measured, cross-validated
evidence on its own, and is already smaller than the ~2.5% run-to-run proving-time noise
the 2026-07-22 baseline measured — so even a completed proving-time A/B would likely have
shown "no measurable difference," which is the same conclusion the constraint count
already supports directly.

### Test suite

| Suite | Result | Command |
|---|---|---|
| Circuits (production, unmodified) — **HASH-ONLY mode** | **108/108 pass** (43 transfer + 30 compliance + 35 withdraw) | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` (run individually) |
| Poseidon2 KAT self-test | **PASS** | `node --experimental-vm-modules scripts/bench/poseidon2.mjs` |
| Poseidon2 Merkle-hasher negative tests (witness-level, see Results) | **4/4 pass** | `node --experimental-vm-modules circuits/experiments/test/poseidon2_merkle.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bun run test` |
| Move contracts | **NOT RUN** (unchanged blocker — no `sui` CLI, see Toolchain gaps) | `sui move test` |

**On "HASH-ONLY mode":** this repo's containers are ephemeral — the 2026-07-22 baseline's
build artifacts (wasm/zkey for the production circuits) did not persist into this
session, and this session's own zkey setup was too slow to redo within budget (same
issue as this experiment's own zkey — see Results, "Proving time"). `circuits/test/*.test.mjs`
is written to degrade gracefully when `build{,-withdraw,-compliance}/` artifacts are
absent: it falls back from full `groth16.fullProve`/`verify` to a hash-only constraint
simulation in plain JS. That's what actually ran and what 108/108 above reports — a real
result, just a weaker one than re-running the full production zkey setup would give. No
production circuit, Move module, or frontend code was modified — the circuit change lives
entirely under `circuits/experiments/` and `circuits/templates/poseidon2/`, so this table
is a sanity check on an untouched blast radius, not a regression test for anything this PR
actually changes.

## Verdict: **REJECT** (production circuits unchanged — keep the branch, the knowledge survives)

A correctly cross-validated Poseidon2 Merkle hasher measurably reduces `transfer.circom`
and `compliance.circom` by 40 constraints each (**-0.29%, -0.31%**) — real, not estimated,
but too small to justify shipping a second hash primitive into circuits that are already
audited around a single one (every domain-tag hash stays Poseidon; only the Merkle
hasher would differ). The audit surface a second primitive adds — a new template, new
constants, a new place for a transcription error, a verifying-key change that ripples
into the deployed Move contracts and requires a fresh ceremony — is not worth 0.3%. This
is the headline finding, not a footnote: **Poseidon2's efficiency argument does not apply
to Groth16/R1CS circuits the way it applies to the AIR/STARK provers it was designed for**,
because R1CS's linear layer is already free. Anyone evaluating Poseidon2 for a Groth16
circuit should measure the round-count delta first, before touching any code — it may be
a wash or even a regression depending on the specific arity/parameter set.

The working, cross-validated Poseidon2 template, JS reference, and benchmark harness are
kept (not deleted) — reusable if a future night finds Poseidon2 parameters for `t=5`, or
decides the 4-input domain-tag hashers are worth restructuring to fit a supported arity.
`BASELINE.md` is **not** updated (no production circuit changed).

## Where this could be used

- **The general lesson — "measure the round-count delta before adopting Poseidon2 in a
  Groth16/R1CS circuit"** — applies to any Circom/Groth16 protocol on Sui, Ethereum, or
  elsewhere considering the same swap for the same reason (a paper headline number that
  was measured against a different cost model). This is the actual deliverable of
  tonight, more than the specific 0.3%.
- **A thesis chapter comparing proof systems' cost models** (R1CS vs AIR/PLONKish) needs
  exactly this kind of concrete counter-example: "linear-layer optimizations that matter
  for system X don't automatically matter for system Y" is usually asserted, rarely shown
  with a real before/after constraint count on the same circuit.
- **`scripts/bench/poseidon2.mjs` and `circuits/templates/poseidon2/`** are directly
  reusable the day this repo (or another Circom project) needs Poseidon2 at `t=3` for any
  other 2-to-1 compression use — e.g. a different Merkle tree, a different protocol
  entirely — without redoing the KAT cross-validation.

## Open questions (next queue)

1. **On-chain gas per entry point** — still BLOCKED, same reasons as 2026-07-22, now with
   the crates.io dead-end confirmed too. Stays at the top of the queue.
2. **Poseidon2 for `t=5`** — no published HorizenLabs parameter set covers it. Either find
   a second, independently cross-checkable source for `t=5` BN254 parameters (not just
   one library's say-so), or evaluate restructuring the 4-input commitment/nullifier
   preimages to fit a supported arity (`t=4` or `t=8`) — the latter is a real protocol
   change (changes what's hashed) and needs its own soundness argument, not a follow-on
   to this one.
3. Given linear layers are free in R1CS, is there a *different* lever this cost model
   actually rewards for Merkle-path hashing specifically — e.g. a compression function
   with fewer total rounds at the same security level, or arity-3 Merkle trees (fewer
   levels, more per-level fan-in) trading tree depth against per-level hash cost? Worth
   a real "count don't guess" pass before assuming Poseidon-family hashing is anywhere
   near its floor for this circuit.
