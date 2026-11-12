# Poseidon2 Merkle hasher with folded linear layers — REJECT (rematch, disclosed)

**Date:** 2026-11-12 · **Queue item:** #2 (Poseidon2 vs Poseidon) · **Verdict:** **REJECT**
**Branch:** `research/2026-11-12-poseidon2-folded-linear-layers`

> **Read this first: this is a rematch, and it should not have been one.** Main's `LEDGER.md` only
> has the 2026-07-22 row, so this run picked queue item #2 as "unsettled". Only *after* measuring
> did it find that this question was already answered in **open, unmerged** PRs:
> #113 (`poseidon2-merkle-node`, REJECT), #114 (`poseidon2-r1cs`, REJECT), #117
> (`poseidon2-r1cs-cost`, REJECT). Nobody can see those verdicts from main, so every night re-runs
> them. See [Loop health](#loop-health-the-real-finding-tonight) — it matters more than the
> Poseidon2 number. This report keeps only what is new compared with those PRs: a
> Poseidon2 template that **folds the linear layers into the S-box inputs**. That variant drops below
> the 2^13 FFT domain and still proves **slower**, and the report measures why.

## Hypothesis

Swapping the depth-20 Merkle hasher in `transfer.circom` from circomlib `Poseidon(2)` to
Poseidon2 (BN254, t=3), written so that its linear layers cost zero R1CS constraints, cuts
**Node Groth16 proving time for `transfer.circom` by ≥10%**. It should do that by taking the
circuit under 8,192 constraints, which halves the FFT domain from 2^14 to 2^13.

Falsified. Constraints drop by 40% and the domain halves as predicted, but proving time goes
**up**, by 9.3% (run 2) and 11.8% (run 1).

## Threat / privacy model

- **Adversary:** this is a performance experiment. The adversary that matters is a **malicious
  prover**: the hash template must not be under-constrained. A template that leaves a free wire
  would let someone forge a Merkle membership, i.e. spend a commitment that is not in the tree
  (STRIDE **S2**, and indirectly **T4**).
- **What the observer sees:** nothing changes. The public inputs, proof size (128 B) and VK shape
  are identical. A chain observer learns nothing new. The anonymity set is unchanged (see residual).
- **Residual surface, stated bluntly:** a faster or cheaper hash does nothing for the linkability
  finding that PR #117 reports (`oldCommitment` / `commitment` are public inputs that `pool.move`
  consumes by exact key, so the Merkle proof hides nothing). That finding is unmerged and
  unaddressed. If it is correct, it outranks any prover-time work.
- **Assumptions:** Poseidon2 security per Grassi–Khovratovich–Schofnegger (2023), with HorizenLabs
  BN254 t=3 parameters (d=5, R_F=8, R_P=56). Compression is `perm([a,b,0])[0]`, the same sponge
  shape and capacity as circomlib's Poseidon. Groth16 still uses a single-contributor dev setup
  (RR2 unchanged). Tonight's pot15 was **generated locally** (see Approach), which is fine for timing
  and size and must never be used for production.
- **STRIDE mapping:** S2 (soundness of the hash gadget, covered by the negative tests below). No
  change to any I-/T-/D- entry.

## Approach

1. Extracted the 64×3 round constants from HorizenLabs/poseidon2 (`poseidon2_instance_bn256.rs`,
   commit `055bde3f`) with `scripts/bench/poseidon2/gen-constants.mjs`. Wrote a BigInt reference
   (`poseidon2.mjs`) that matches the reference KAT `perm([0,1,2])` bit for bit.
2. Wrote `circuits/research/poseidon2.circom`. Each S-box is 3 multiplications on a *linear
   combination* (`x2 <== lc*lc; x4 <== x2*x2; y <== x4*lc`). The external and internal matrices
   are carried in `var`s, so they cost **0 constraints**. This is the design choice that separates it
   from PRs #113/#114/#117, which materialise the state as signals.
3. `circuits/research/merkle_proof_p2.circom` is `merkle_proof.circom` with only the hasher swapped.
   `scripts/bench/poseidon2/bench-variants.mjs` compiles transfer and compliance with both hashers
   (project-default `-O1`, plus a `--O2` compile for context). It runs Groth16 setup, checks that a
   proof verifies, and times `fullProve` (10 runs, warm-up excluded). It also splits
   witness generation from `groth16.prove`, and counts A/B coefficients in the zkey.
4. **Rejected before building:** Poseidon2 for t=4..6 (arities 3–5). There are no audited BN254
   parameters for those widths in the HorizenLabs repo, and inventing round constants is not
   something a nightly run should do. Also rejected: an on-chain Poseidon2. It is not needed,
   because the commitment root is computed off-chain and posted by the admin
   (`pool.move:395`), so there is no Move-side hash to change.

**Toolchain blockers hit on the way (all recorded in raw form below):**
- Queue item #1 (gas) was tried first and is **BLOCKED for the 3rd+ time**.
  `github.com/.../releases` and `fullnode.testnet.sui.io` return 403 from the egress proxy.
  `git` over HTTPS to GitHub works, and Sui `testnet-v1.72.1` (= `Move.lock` rev `94ad8cc`) was
  fetched, but **building it was denied by the session's permission layer**. Per policy, this run
  did not retry or route around the denial.
- `https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau` now returns **403**.
  This URL is hard-coded in `circuits/scripts/compile.sh` *and* in `.github/workflows/ci.yml`, so
  CI's circuit job fails on main itself. A dev pot15 was generated locally instead
  (`snarkjs powersoftau new bn128 15` → `contribute` → `prepare phase2`: 5m28s).

## Results

Machine: 4× Intel Xeon @ 2.30 GHz, Node v22.23.4, circom 2.2.2, snarkjs 0.7.6.
Command: `node scripts/bench/poseidon2/bench-variants.mjs --runs 10 --ptau circuits/build/pot15_final.ptau`
(run twice; both runs below, full raw log of run 2 in `raw/2026-11-12-bench-variants.log`).

### Single 2-to-1 hash (`scripts/bench/poseidon2/circuits/*.circom`)

| Hash | -O1 non-linear | -O1 linear | -O1 total | --O2 non-linear | --O2 linear |
|---|---|---|---|---|---|
| circomlib `Poseidon(2)` | 243 | 274 | 517 | 240 | 0 |
| Poseidon2 t=3, signal-per-S-box-input (first draft) | 240 | 83 | 323 | — | — |
| **Poseidon2 t=3, folded linear layers (this PR)** | 240 | 3 | **243** | 240 | 0 |

### Full circuits (run 2, 10 proving runs each)

| Circuit | Constraints (-O1) | Wires | FFT domain | A/B coefs in zkey | zkey (B) | witness (ms) | `groth16.prove` (ms) | **fullProve mean ± sd (ms)** |
|---|---|---|---|---|---|---|---|---|
| `transfer` (baseline) | 13,611 | 13,632 | 16,384 | 13,394 | 6,001,419 | 70.1 | 637.6 | **714.3 ± 33.7** |
| `transfer_p2` | **8,131** (−40.3%) | 8,152 | **8,192** | **129,974** (9.7×) | 8,853,051 (+47.5%) | 55.5 | 699.0 | **780.4 ± 32.2 (+9.3%)** |
| `compliance` (baseline) | 12,743 | 12,762 | 16,384 | 12,465 | 5,682,143 | 82.4 | 636.7 | **719.6 ± 39.3** |
| `compliance_p2` | **7,263** (−43.0%) | 7,282 | **8,192** | **129,045** (10.4×) | 8,533,775 (+50.2%) | 60.6 | 668.2 | **779.9 ± 49.0 (+8.4%)** |

Run 1 (same script before the split-timing columns were added):
transfer 672.2 ± 24.6 → transfer_p2 751.8 ± 22.8 (**+11.8%**); compliance 637.1 ± 16.3 →
compliance_p2 730.9 ± 14.6 (**+14.7%**).

Under `--O2`, **both** variants of transfer compile to 6,384 non-linear / 0 linear, and both
variants of compliance to 5,979 / 0. With the optimiser on, Poseidon2 saves exactly zero
constraints. VK and on-chain proof size are unchanged (VK ≈ 4.0 KB, 128 B proof). All four
proofs verify.

**Mechanism (measured, not inferred):** witness generation gets *faster* (−21% / −26%), because
there are fewer signals to compute. But `groth16.prove` gets *slower* (+9.6% / +4.9%). Folding
the linear layers means each partial-round S-box input is a linear combination of ~60 earlier
signals, and it appears in both A and B (`lc*lc`). That multiplies the A/B coefficient count by
~10×. snarkjs evaluates A·w and B·w over those coefficients in JS before the FFTs, and that extra
work costs more than halving the domain saves. The zkey grows by ~2.8 MB, which also matters
for browser download size.

### Soundness / negative tests

`node scripts/bench/poseidon2/poseidon2.test.mjs`:
```
Poseidon2 BN254 t=3 — correctness and soundness tests
  PASS P1 JS reference == HorizenLabs KAT perm([0,1,2])
  PASS P2 circom Poseidon2PermT3([0,1,2]) == KAT
  PASS P3 circom Poseidon2Hash2 == JS hash2 on 25 inputs
  PASS P4 honest witness satisfies all 243 constraints
  PASS N1 forged output (out+1) rejected
  PASS N2 forged interior S-box (x4[12]=found, y recomputed) rejected
  PASS N3 all 243 non-input signals are constrained (no free wire)

7 passed, 0 failed
```
N1–N3 evaluate the R1CS directly with an independent JS evaluator over `snarkjs r1cs export json`.
N3 perturbs every non-input wire in turn and confirms that each change breaks a constraint, so the
gadget has no under-constrained signal. **Soundness argument:** every S-box output `y` is pinned by
`y = x4·lc`, `x4 = x2²`, `x2 = lc²`, where `lc` is a fixed linear function of the inputs and
earlier pinned `y`s. By induction over rounds, each signal is a deterministic function of the inputs,
and the output equals the reference permutation (P2/P3). No production circuit was changed, so
the production soundness argument is untouched.

### Raw output (run 2, abridged; full log in `raw/2026-11-12-bench-variants.log`)
```
=== Poseidon vs Poseidon2 Merkle hasher — 10 proving runs/variant ===
node v22.23.4, linux/x64, 4x Intel(R) Xeon(R) Processor @ 2.30GHz
circom compiler 2.2.2 | ptau /home/user/veil/circuits/build/pot15_final.ptau
--- transfer ---
  circom -O1: non-linear 6470, linear 7141, wires 13632 | --O2: non-linear 6384, linear 0
  zkey 6001419 B, vk 4022 B, wasm 2846127 B, proof verifies: true
  split: witness 70.1 ms + groth16.prove 637.6 ms (sd 31.8); A/B coefficients in zkey: 13394
  prove: mean 714.3 ms, sd 33.7, min 680.2, max 781 (10 runs)
--- transfer_p2 ---
  circom -O1: non-linear 6410, linear 1721, wires 8152 | --O2: non-linear 6384, linear 0
  zkey 8853051 B, vk 4020 B, wasm 2481297 B, proof verifies: true
  split: witness 55.5 ms + groth16.prove 699 ms (sd 28.4); A/B coefficients in zkey: 129974
  prove: mean 780.4 ms, sd 32.2, min 725.5, max 818.4 (10 runs)
--- compliance ---
  circom -O1: non-linear 6057, linear 6686, wires 12762 | --O2: non-linear 5979, linear 0
  zkey 5682143 B, vk 3836 B, wasm 2931887 B, proof verifies: true
  split: witness 82.4 ms + groth16.prove 636.7 ms (sd 30); A/B coefficients in zkey: 12465
  prove: mean 719.6 ms, sd 39.3, min 654.4, max 799 (10 runs)
--- compliance_p2 ---
  circom -O1: non-linear 5997, linear 1266, wires 7282 | --O2: non-linear 5979, linear 0
  zkey 8533775 B, vk 3842 B, wasm 2590273 B, proof verifies: true
  split: witness 60.6 ms + groth16.prove 668.2 ms (sd 33.8); A/B coefficients in zkey: 129045
  prove: mean 779.9 ms, sd 49, min 710.4, max 857.9 (10 runs)
```
Single-hash counts: `circom <file>.circom --r1cs [--O2]` in `scripts/bench/poseidon2/circuits/`:
```
non-linear constraints: 243 linear constraints: 274 wires: 520  <- hash_p1
non-linear constraints: 240 linear constraints: 3 wires: 246    <- hash_p2
non-linear constraints: 240 linear constraints: 0 <- hash_p1 --O2
non-linear constraints: 240 linear constraints: 0 <- hash_p2 --O2
non-linear constraints: 264 linear constraints: 341 wires: 609  <- hash_p1_n3 (circomlib Poseidon(3))
non-linear constraints: 300 linear constraints: 436 wires: 741  <- hash_p1_n4 (circomlib Poseidon(4))
non-linear constraints: 324 linear constraints: 511 wires: 841  <- hash_p1_n5 (circomlib Poseidon(5))
```
(The wider circomlib instances are recorded for per-instance cost attribution; Poseidon2 was not
built for t=4..6, see Approach.)

### Full suite (CI's steps, run locally)
- `circuits`: compiled per `ci.yml` with the local pot15 → `npm test`: **43 + 30 + 35 passed, 0 failed**
  (real Groth16 proofs).
- `scripts`: `test-converter` "All tests passed."; `test-compliance-utils` "All tests passed.";
  `fuzz-tests` "ALL 6 PROPERTIES PASSED".
- `frontend`: `tsc --noEmit` exit 0; `biome check .` exit 0; `vitest run`: 3 files, 19 tests passed.
- `contracts` (`sui move test`): **NOT RUN**, because there is no `sui` binary (see blockers).
- GitHub CI on this PR is expected to be **red for reasons unrelated to this diff**: on main, the
  pot15 URL returns 403 and `oven-sh/setup-bun@735343b6…` no longer resolves (both seen in run
  42979714319 for PR #117). That is why this PR is a draft.

## Verdict — **REJECT**

The earlier PRs' REJECT holds, and tonight's data adds a stronger reason. Under `-O1`, the most
constraint-efficient Poseidon2 layout takes 40% of the constraints out and halves the FFT domain,
yet it still proves 8–15% *slower*, because density moves into the A/B matrices. Under `--O2`,
Poseidon and Poseidon2 are identical in R1CS. Poseidon2's advantage is a cheaper *native* linear
layer, and in R1CS a linear layer is already free. **Do not re-run Poseidon2-for-Groth16 again.** It
is now settled four times over. The branch is kept for the template and tests.

General lesson worth keeping: **constraint count is a bad proxy for snarkjs prover time when you
trade linear constraints for coefficient density.** Measure `groth16.prove`, not `r1cs info`.

## Where this could be used

- **Any circom/snarkjs project that is tempted to "optimise" by folding linear algebra into
  quadratic constraints**, for example Tornado-style mixers and Semaphore-style group membership
  with a Poseidon Merkle path. The density trap applies to any gadget with large MDS layers
  (Poseidon partial rounds, Rescue, MiMC-Feistel with wide states).
- **Poseidon2 *does* pay off off-circuit and in Plonkish/AIR systems** (Plonky3, Noir/Barretenberg,
  where native hashing or custom gates dominate). If Veil ever moves to a PLONK-family prover
  (queue #9), revisit Poseidon2 there, not in Groth16.
- **Thesis:** a short section in the "prover cost model" chapter: R1CS constraint count vs.
  snarkjs prover time, with this circuit pair as a worked counter-example.

## Open questions

1. Is there an intermediate layout that materialises the Poseidon2 state every *k* partial rounds
   and stays under 8,192 constraints while keeping A/B density low? This is low priority, since
   `--O2` makes the question moot for Veil.
2. Does `--O2` itself raise A/B density the same way? PR #117 measured a 22–25% proving speed-up
   under `--O2`, which suggests circom's linear substitution is better behaved. Confirm with the
   `abcCoefs` column of this script before adopting it.
3. Browser: does +2.8 MB of zkey outweigh the faster witness generation on mobile?

## Loop health (the real finding tonight)

- **At least 10 research PRs are open and unmerged** (#108–#117). Several are gas attempts, and
  #108/#110/#112 are titled "onchain-gas-baseline", so real gas numbers may already exist in one of
  them. Because none of them merged, main's `LEDGER.md`, `EXPERIMENTS.md` and `BASELINE.md` never
  move, and the loop keeps re-running items #1 and #2.
- **CI is red on every research PR for infrastructure reasons**: the pot15 URL returns 403 and the
  `setup-bun` SHA pin no longer resolves. So "green → normal PR" is never reachable.
- Suggested unblock (needs the owner; not done here because it is out of this experiment's scope):
  (a) fix CI by vendoring or rehosting pot15 (or generating one in CI) and re-pinning `setup-bun`;
  (b) merge or close the open research PRs, at minimum the ledger rows, so that the queue reflects
  reality; (c) look at #117's I7 linkability finding first, because it is a privacy claim, not a
  performance one.
