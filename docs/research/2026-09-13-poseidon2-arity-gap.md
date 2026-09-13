# 2026-09-13 — Poseidon2 vs Poseidon: constraint-count delta at Veil's supported arities (queue item #2)

## Hypothesis

Swapping circomlib's Poseidon for Poseidon2 (TaceoLabs' `@taceo/circom-lib`, parameters compatible
with the HorizenLabs reference script) at the two input arities Veil's circuits actually use with a
*published* Poseidon2 parameter set — 2 inputs (t=3, `withdraw.circom`'s `recipientHash`) and 3
inputs (t=4, `transfer.circom`'s `txAmountHash` and `compliance.circom`'s `nfHash`/`ctxHash`) —
reduces R1CS constraint count per hash call by a double-digit percentage, the way the "Poseidon2 is
cheaper" literature is usually read to imply.

This is **falsified** by direct measurement. At `circom`'s default optimization level (no `-O`
flag — what `circuits/scripts/compile*.sh` actually ships), Poseidon2 is 12–41% *more* expensive in
total R1CS constraints at both arities tested. At full compiler optimization (`--O2`), the gap
closes to parity at t=3 and a 1.1% regression at t=4. Non-linear (S-box) constraint count — the
part of the literature's efficiency claim that's actually about arithmetic complexity, not linear
algebra — is roughly flat too (-1.2% at t=3, 0% at t=4, unoptimized; identical/near-identical at
`--O2`). Separately, four of Veil's seven Poseidon call sites use arities (t=5, t=6) that have **no
published Poseidon2 parameter set at all** in the libraries checked — see Results and Verdict.

## Threat / privacy model

A hash-function swap inside a ZK circuit is a soundness-and-privacy-relevant change, not a pure
performance tweak, so this section covers what changes and what doesn't even though the eventual
verdict is "don't ship it."

**What Poseidon2 (if adopted) would and wouldn't change, for each adversary in scope:**

- **Chain observer** (sees on-chain commitments, nullifiers, Merkle roots, proof bytes). Under the
  random-oracle heuristic both Poseidon and Poseidon2 are modeled identically: fixed-size,
  non-invertible, collision-resistant outputs. Swapping one for the other changes *nothing* about
  what a chain observer learns — commitments and nullifiers remain uniformly-distributed-looking
  field elements either way. This experiment does not touch `docs/threat-model.md` I2/I6
  (information disclosure via commitments/nullifiers): both are already "Mitigated" and stay that
  way under either hash.
- **Malicious prover** (tries to forge a proof for a false statement). Soundness of the
  `expectedHash === computedHash` equality this experiment's bench circuits use rests on (a)
  Groth16/BN254 soundness — unchanged — and (b) the R1CS actually pinning `computedHash`, i.e. no
  under-constrained signal lets a prover claim an arbitrary hash. Verified directly: seven of the
  13 tests in `circuits/bench/poseidon2/test/poseidon2.test.mjs` are exactly this check (§Results).
- **Colluding relayer / statistical deanonymizer / auditor / quantum adversary**: unaffected either
  way — none of their capabilities depend on which Poseidon variant computes a commitment or
  nullifier, only on the hash's black-box properties, which this experiment doesn't change (see
  "residual surface" below).
- **A future implementer who *does* attempt this swap for real** (this experiment doesn't, but the
  question is worth answering once): changing `transfer.circom`/`compliance.circom`/
  `withdraw.circom`'s hash function changes the circuit, hence the verifying key, hence requires
  `propose_vk_update` + the 1-epoch timelock already in place for exactly this reason
  (`docs/threat-model.md` T3, "Modify VK to accept forged proofs" — mitigated by timelock, not
  relevant here as a threat but relevant as the *deployment mechanism* a real migration would use).
  It would also need every off-chain caller of the same hash (`scripts/src/compliance-utils.ts`,
  `scripts/src/seed-credential-tree.ts`, `frontend`'s witness builders, `circuits/templates/
  merkle_proof.circom`) updated in lockstep, or old and new commitments become mutually
  unrecognizable — a real migration, not a parameter tweak. Out of scope tonight; noted for the
  queue.

**What this does NOT defend against or establish (residual surface):** this experiment says
nothing about Poseidon2's own cryptanalytic security margin (number of rounds vs. best known
attacks) — it trusts the published parameter set exactly as given, the same trust Veil already
extends to circomlib's Poseidon parameters. It does not evaluate Poseidon2 at the arities Veil
would actually need for a *full* migration (t=5, t=6 — see Results); the two published,
tested-tonight arities (t=3, t=4) are not the ones carrying most of Veil's Poseidon constraint
weight (`compliance.circom`'s `leafHash` alone, at t=6, is one call; `transfer.circom`/
`withdraw.circom`'s four-input commitment and nullifier hashes, at t=5, are six calls across the
three circuits — see BASELINE.md's non-linear constraint totals). And it does not touch the
Groth16 trusted-setup risk (`docs/threat-model.md` RR2) at all — the dev-only Powers-of-Tau this
experiment generated is exactly as non-production as the existing one.

**Assumptions**: BN254 discrete-log hardness (Groth16 soundness, unchanged), both Poseidon variants
treated as random oracles at their stated round counts (unverified independently — see above), and
the dev-only single-contributor setup this experiment's own benchmarking used
(`scripts/bench/poseidon2-constraints.sh` generates its own local Powers of Tau — see "Toolchain
gaps" below) is not production-safe, same caveat as `docs/threat-model.md` RR2.

## Approach

**What I built**, all under `circuits/bench/poseidon2/` (kept fully outside `transfer.circom` /
`compliance.circom` / `withdraw.circom` — see "What I rejected"):

- `poseidon2_hash.circom` — `Poseidon2Hash(nInputs)`, a fixed-input-length hash built on
  `@taceo/circom-lib`'s raw `Poseidon2(t)` permutation (added as a real npm dependency of
  `circuits/`, not hand-copied, so `npm install` pins and reproduces the exact same source). It
  mirrors circomlib's own `Poseidon(nInputs)`/`PoseidonEx` convention exactly: state =
  `[0, in[0], ..., in[nInputs-1]]` (capacity slot first, initialized to 0), permute, output
  `state'[0]`. This is not a novel sponge mode — it's the same "permutation + fixed capacity +
  single-word squeeze" construction circomlib already uses, so the comparison is apples-to-apples
  at the call-site level, not permutation-vs-hash.
- Four tiny `main` circuits — `main_poseidon_t3`/`main_poseidon2_t3` (2 inputs) and
  `main_poseidon_t4`/`main_poseidon2_t4` (3 inputs) — each taking `in[nInputs]` (private) and
  `expectedHash` (public) and constraining `expectedHash === hash(in)`. The equality constraint
  (rather than a bare unused output) is what makes the negative test meaningful: a forged
  `expectedHash` must actually break proving, not just go unchecked.
- `scripts/bench/poseidon2-constraints.sh` — reusable, cites its exact commands: compiles all four
  circuits twice (default optimization, matching `compile*.sh`; then `--O2`), runs
  `snarkjs r1cs info` as a cross-check against the compiler's own report, generates a local
  dev-only Powers of Tau (2^10 — see "Toolchain gaps"), runs the dev-only Groth16 setup per
  circuit, then calls:
- `scripts/bench/poseidon2-prove-latency.mjs` — same `fullProve`-timing methodology as
  `scripts/bench/prove-latency.mjs` (one uncounted warm-up run, then N timed repetitions).
- `circuits/bench/poseidon2/test/poseidon2.test.mjs` — 13 tests: per circuit, (1) a correct witness
  proves and verifies *and* its `expectedHash` matches an independent JS reference
  (`circomlibjs`'s `buildPoseidon` for the baseline circuits, `@taceo/poseidon2`'s `bn254.t3`/`t4`
  permutation — a different package, different author's port of the same published parameters —
  for the Poseidon2 circuits); (2)/(3) two forged-`expectedHash` witnesses (`+1`, and `0`) are both
  rejected; plus one sanity check that the two hash functions actually disagree on the same input
  (ruling out an accidental no-op wrapper).

**What I rejected:**

- **Modifying the production circuits directly.** Even restricted to the two arities that have a
  drop-in Poseidon2 parameter set (`transfer.circom`'s `txAmountHash`, `compliance.circom`'s
  `nfHash`/`ctxHash`, `withdraw.circom`'s `recipientHash` — 4 of 10 total Poseidon call sites), a
  real swap changes those circuits' verifying keys and requires the off-chain hash callers listed
  above to change in lockstep. That's a coordinated migration, not a benchmark, and — per the
  Results below — there's no performance case for it anyway. Building it would have spent the
  night's budget proving a negative in the most expensive possible way.
- **Deriving Poseidon2 round constants for t=5/t=6 myself.** The Poseidon2 paper's published
  parameter sets stop at t ∈ {2,3,4,8,12,16} (compression/sponge widths, not "however many inputs a
  particular protocol happens to need"); Veil's 4- and 5-input hashes (t=5, t=6, from circomlib's
  `Poseidon(4)`/`Poseidon(5)` convention: t = nInputs+1) fall outside that set. Generating novel
  round constants for an unpublished width and shipping them without independent cryptanalytic
  review would be exactly the kind of invented-and-unverified cryptography this loop's rules
  prohibit ("no estimates presented as measurements" extends to "no home-rolled parameters
  presented as secure").
- **A sponge construction that pads Veil's 4/5-input hashes into a supported width (t=8).**
  Feasible in principle (absorb 4 or 5 field elements plus domain tag into an 8-element sponge with
  zero-padding, one permutation call), but it changes the domain-separation encoding Veil's
  circuits currently use (`transfer.circom`'s comment block, "Domain separation tags (first
  Poseidon input)") and is a real design change requiring its own soundness argument, not a
  drop-in swap. Flagged for the queue rather than attempted tonight, to keep this experiment to the
  one hypothesis it started with.

**Toolchain gaps hit along the way:**

- `circom` was not installed (fresh container). Built from source exactly as BASELINE.md did:
  `cargo install --git https://github.com/iden3/circom.git --tag v2.2.2 circom` (~1 minute
  compile, no issues this time — installed straight to `~/.cargo/bin`, already on `PATH`).
- The Hermez `pot15_final.ptau` URL `circuits/scripts/compile.sh` downloads from
  (`storage.googleapis.com`) returned **403** through this session's network egress policy — same
  class of denial BASELINE.md hit against `fullnode.testnet.sui.io`, confirmed again tonight with a
  fresh `curl` (`HTTP 000`, proxy status log: `"connect_rejected", "gateway answered 403 to CONNECT
  (policy denial)"`). Per this environment's own instructions ("do not retry or route around a
  policy denial"), I did not attempt a workaround for that specific host. Instead — since a
  Powers-of-Tau ceremony needs no network at all, only entropy and CPU — I generated a fresh local
  one for the toy bench circuits (`snarkjs powersoftau new bn128 10 ... | contribute | prepare
  phase2`, 2^10 — comfortably above the largest bench circuit's 852 constraints) and, separately,
  a local `pot15` for `circuits/build/`, sized identically to the one BASELINE.md downloaded, so
  the full existing test suite could run against real artifacts tonight too (see Results, Test
  suite). Both are the same "single dev-only contribution, not a production ceremony" pattern
  `circuits/scripts/compile.sh` already documents — generated locally instead of downloaded is a
  process difference, not a trust-model difference.
- The `sui` CLI is still not installed and still not reachable by any path this session's network
  policy allows (`fullnode.testnet.sui.io` denied identically to BASELINE.md's attempt). Move
  contract tests (124 tests) remain **NOT RUN**, unchanged from BASELINE.md — no contract code was
  touched tonight either, so the risk from skipping them is the same as last time: real, but low.

## Results

### R1CS constraint counts (raw `circom --r1cs --wasm --sym` output, cross-checked with `snarkjs r1cs info`)

Default optimization (no `-O` flag — matches `circuits/scripts/compile*.sh`):

| Hash call | Non-linear | Linear | **Total** | Δ non-linear | Δ total |
|---|---|---|---|---|---|
| Poseidon(2) [t=3, baseline] | 243 | 274 | **517** | — | — |
| Poseidon2(3) [t=3, candidate] | 240 | 340 | **580** | **-1.2%** | **+12.2%** |
| Poseidon(3) [t=4, baseline] | 264 | 341 | **605** | — | — |
| Poseidon2(4) [t=4, candidate] | 264 | 588 | **852** | **0.0%** | **+40.8%** |

Full compiler optimization (`--O2`, eliminates pure-linear R1CS rows algebraically):

| Hash call | Non-linear (linear is 0 at `--O2`) | Δ |
|---|---|---|
| Poseidon(2) [t=3] | 240 | — |
| Poseidon2(3) [t=3] | 240 | **0.0%** |
| Poseidon(3) [t=4] | 261 | — |
| Poseidon2(4) [t=4] | 264 | **+1.1%** |

Raw command and output (full log: every circuit, both optimization levels, `snarkjs r1cs info`
cross-check, ptau generation, Groth16 setup, and proving-time run — reproduced by
`bash scripts/bench/poseidon2-constraints.sh --runs 10`):

```
$ circom main_poseidon_t3.circom --r1cs --wasm --sym --output build
non-linear constraints: 243
linear constraints: 274
wires: 520

$ circom main_poseidon2_t3.circom --r1cs --wasm --sym --output build
non-linear constraints: 240
linear constraints: 340
wires: 583

$ circom main_poseidon_t4.circom --r1cs --wasm --sym --output build
non-linear constraints: 264
linear constraints: 341
wires: 609

$ circom main_poseidon2_t4.circom --r1cs --wasm --sym --output build
non-linear constraints: 264
linear constraints: 588
wires: 856

$ circom main_poseidon_t3.circom --r1cs --wasm --sym --O2 --output build-o2
non-linear constraints: 240
linear constraints: 0

$ circom main_poseidon2_t3.circom --r1cs --wasm --sym --O2 --output build-o2
non-linear constraints: 240
linear constraints: 0

$ circom main_poseidon_t4.circom --r1cs --wasm --sym --O2 --output build-o2
non-linear constraints: 261
linear constraints: 0

$ circom main_poseidon2_t4.circom --r1cs --wasm --sym --O2 --output build-o2
non-linear constraints: 264
linear constraints: 0

$ npx snarkjs r1cs info build/main_poseidon_t3.r1cs
[INFO]  snarkJS: # of Constraints: 517
$ npx snarkjs r1cs info build/main_poseidon2_t3.r1cs
[INFO]  snarkJS: # of Constraints: 580
$ npx snarkjs r1cs info build/main_poseidon_t4.r1cs
[INFO]  snarkJS: # of Constraints: 605
$ npx snarkjs r1cs info build/main_poseidon2_t4.r1cs
[INFO]  snarkJS: # of Constraints: 852
```

### Why total constraints, not just non-linear, are the number that matters here

circom's "non-linear" vs "linear" split is an implementation artifact (whether a `<==` row happens
to involve two non-constant signals or reduces to a constant-coefficient linear combination) —
Groth16's prover cost scales with *total* R1CS constraints (the QAP's domain size is the next power
of two above the total, and both the linear and non-linear rows shown above are real rows in that
matrix). Poseidon2's S-box count here is essentially identical to Poseidon's at these arities (same
8 full rounds; partial-round counts differ by at most one — `amountPartialRounds(t)` in
`@taceo/circom-lib` gives 56 for t≤4, vs. circomlib's 57 at t=3 and 56 at t=4), so the *native*
multiplication-count efficiency Poseidon2 is designed for shows up faintly if at all in the
non-linear column. What actually moves is the linear layer: `@taceo/circom-lib`'s
`ExternalMatMulT`/`InternalMatMulT` templates introduce one `<==` signal per intermediate sum
(`Acc`, per-round accumulator sums), each counted as a "linear constraint" until `--O2` eliminates
them algebraically. circomlib's `Mix`/`MixS` templates fold the same arithmetic into fewer
intermediate signals. At default optimization — what actually ships, per `compile*.sh` — that
difference is the whole story: more rows, more prover work, full stop.

### Proving time (mean of 10 runs, `node scripts/bench/poseidon2-prove-latency.mjs --runs 10`)

```
--- main_poseidon_t3 ---   mean: 130.958 ms   stddev: 8.294 ms   min: 119.827 ms   max: 142.343 ms
--- main_poseidon2_t3 ---  mean: 101.308 ms   stddev: 6.008 ms   min: 94.816 ms    max: 109.573 ms
--- main_poseidon_t4 ---   mean: 129.765 ms   stddev: 10.009 ms  min: 117.271 ms   max: 152.632 ms
--- main_poseidon2_t4 ---  mean: 114.375 ms   stddev: 8.857 ms   min: 100.160 ms   max: 129.164 ms
```

Read this number with real skepticism, not at face value: Poseidon2 measures *faster* wall-clock
here despite having equal-or-more R1CS constraints, because all four circuits (517–852 total
constraints) round up to the same Groth16 FFT domain size (1024). At this toy scale, wall-clock
proving time is dominated by fixed per-call overhead (WASM instantiation, witness-calculator
startup) that swamps a few-hundred-constraint difference — it is not a reliable signal for what
happens inside a 13,611-constraint circuit where the same delta would move the needle directly. The
R1CS constraint count above, not this proving-time table, is the number that actually predicts
production impact; it's included for completeness and because the raw-output rule applies to
negative results too.

### Correctness and negative tests (`node --experimental-vm-modules test/poseidon2.test.mjs`)

```
[PASS] main_poseidon_t3: correct witness proves and verifies (matches independent JS reference)
[PASS] main_poseidon_t3: forged expectedHash (+1) is rejected
[PASS] main_poseidon_t3: forged expectedHash (0) is rejected
[PASS] main_poseidon2_t3: correct witness proves and verifies (matches independent JS reference)
[PASS] main_poseidon2_t3: forged expectedHash (+1) is rejected
[PASS] main_poseidon2_t3: forged expectedHash (0) is rejected
[PASS] main_poseidon_t4: correct witness proves and verifies (matches independent JS reference)
[PASS] main_poseidon_t4: forged expectedHash (+1) is rejected
[PASS] main_poseidon_t4: forged expectedHash (0) is rejected
[PASS] main_poseidon2_t4: correct witness proves and verifies (matches independent JS reference)
[PASS] main_poseidon2_t4: forged expectedHash (+1) is rejected
[PASS] main_poseidon2_t4: forged expectedHash (0) is rejected
[PASS] Poseidon and Poseidon2 reference implementations disagree on the same inputs (sanity check)

=== Results: 13 passed, 0 failed ===
```

The "matches independent JS reference" cases are the soundness-relevant ones: `@taceo/poseidon2`
(a separate npm package, separate author's TypeScript port, explicitly documented as "compatible
with the HorizenLabs parameter script and the Rust taceo-poseidon2 crate") agrees exactly with
`Poseidon2Hash`'s circom output for every input tried. That's independent cross-validation that the
circom wrapper is computing real Poseidon2, not a bug that happens to compile.

### The arity gap (why 6 of Veil's 10 Poseidon calls couldn't be tested at all)

| Circuit | Call | circomlib arity | Internal t | Poseidon2 param set exists? |
|---|---|---|---|---|
| `transfer.circom` | `oldCommitment`/`newCommitment`/`nullifier` (×3) | `Poseidon(4)` | **5** | No |
| `transfer.circom` | `txAmountHash` | `Poseidon(3)` | 4 | **Yes — tested tonight** |
| `compliance.circom` | `leafHash` | `Poseidon(5)` | **6** | No |
| `compliance.circom` | `nfHash`, `ctxHash` (×2) | `Poseidon(3)` | 4 | **Yes — tested tonight** |
| `withdraw.circom` | `commHash`/`changeHash`/`nfHash` (×3) | `Poseidon(4)` | **5** | No |
| `withdraw.circom` | `recipientHash` | `Poseidon(2)` | 3 | **Yes — tested tonight** |

`@taceo/circom-lib` ships parameters for t ∈ {2,3,4,8,12,16} — the widths the Poseidon2 paper
itself gives concrete round constants for. Veil's four- and five-input hashes (t=5, t=6) exist
because circomlib's `Poseidon(nInputs)` convention is `t = nInputs + 1`, not because Veil chose
those widths for a Poseidon2-related reason — they're a byproduct of how many field elements each
commitment/nullifier happens to bind together (CRYPTO-004, CRYPTO-006, CRYPTO-011 in `transfer.
circom`'s comments). Even in the best case tonight's numbers had shown a win, it would only have
applied to 4 of these 10 call sites — the other 6, including every commitment and nullifier hash
(the highest-value targets, being on every transfer), would need either unpublished round constants
or a domain-separation redesign to reach at all.

### Test suite

| Suite | Result | Command |
|---|---|---|
| New: Poseidon2 bench correctness + negative tests | **13/13 pass** | `cd circuits/bench/poseidon2 && node --experimental-vm-modules test/poseidon2.test.mjs` |
| Circuits (real Groth16, unmodified) | **108/108 pass** (43 transfer + 30 compliance + 35 withdraw) | `cd circuits && node test/{transfer,compliance,withdraw}.test.mjs` (run individually, per the known `&&`-chain issue already fixed in `main` — see note) |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Move contracts | **NOT RUN** | `sui` CLI unavailable — same blocker as 2026-07-22, network policy denies the only fallback (fullnode JSON-RPC) |

No test was loosened, skipped, or given new tolerance. No production circuit, Move module, or
frontend file was modified — every change tonight is additive, under `circuits/bench/poseidon2/`
and `scripts/bench/`.

## Verdict: **REJECT**

The hypothesis — that Poseidon2 reduces R1CS constraint count at Veil's supported arities — is
falsified by direct measurement at both optimization levels the actual build pipeline can produce.
There is no performance case for adopting `@taceo/circom-lib`'s Poseidon2 in Veil's circuits today,
and a full migration is additionally blocked by an arity gap affecting 6 of 10 call sites. The
branch (this PR) stays open with the bench circuits, scripts, and tests as a permanent, reproducible
record — re-running it is one command
(`bash scripts/bench/poseidon2-constraints.sh`) if a different Poseidon2 implementation, a
different linear-layer encoding, or published t=5/t=6 parameters ever change the picture.

## Where this could be used

- **Any circom/Groth16 circuit already using circomlib's Poseidon at 2- or 3-input arities**
  considering a Poseidon2 migration for the same "it's supposed to be cheaper" reason — this result
  says: measure your own build pipeline's optimization level first, because the answer flips
  between "slightly worse" (unoptimized, what most `compile.sh`-style scripts actually run) and
  "roughly even" (`--O2`), never "clearly better," at least with this circuit encoding of the
  linear layer.
- **A thesis chapter or survey comparing Poseidon vs Poseidon2 inside SNARK circuits specifically**
  (as opposed to native/plain execution, where Poseidon2's linear-layer savings are real and
  well-documented) — this is a concrete counterexample to importing that native-execution
  intuition unmodified into an R1CS cost model, with a reproducible harness to check it against a
  future Poseidon2 circom implementation that encodes the linear layer differently.
- **Anyone maintaining a circomlib-based protocol who hits the same t=5/t=6 arity gap** — the
  table above generalizes past Veil: any protocol whose commitment scheme binds 4 or 5 field
  elements per hash (a common shape for "value + randomness + owner-secret + optional metadata"
  commitments) will find the same "Poseidon2 doesn't have parameters for my exact arity" wall.

## Open questions (next queue)

1. **On-chain gas per entry point** — still blocked, still top of `EXPERIMENTS.md` (see LEDGER).
   Nothing in tonight's run changes that; re-attempting it with a different unblocking strategy
   remains the highest-value next step.
2. **Does a sponge-based encoding (t=8, absorbing Veil's 4-5 inputs plus a domain tag with
   zero-padding) change the constraint-count picture for the arities Poseidon2 *does* publish
   parameters for?** This would let 6 more of Veil's 10 Poseidon calls be tested, at the cost of a
   real domain-separation redesign — worth scoping as its own experiment with its own soundness
   argument, not a rerun of tonight's.
3. **Does a different Poseidon2 circom encoding of the linear layer (fewer intermediate `<==`
   signals in the matrix-multiplication templates) close the total-constraint gap at default
   optimization?** Tonight's result is specific to `@taceo/circom-lib`'s implementation choices;
   it is not a claim about Poseidon2's ceiling in circom generally.
4. Independent circuit soundness audit (queue item, unstarted) — this experiment's negative tests
   only cover the two toy bench circuits built tonight, not `transfer.circom`/`compliance.circom`/
   `withdraw.circom` themselves.
