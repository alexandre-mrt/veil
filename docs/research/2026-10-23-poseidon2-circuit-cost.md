# 2026-10-23 — Poseidon2 vs circomlib Poseidon, and what actually dominates circuit cost

**Verdict: REJECT (Poseidon2 swap) / KEEP (side-finding: compile with `circom --O2`).**
Queue item #1 (on-chain gas) was attempted first and is **BLOCKED** for the third time — see
[Blocked first](#blocked-first-on-chain-gas-queue-item-1).

## Hypothesis

Replacing circomlib's `Poseidon(n)` with a Poseidon2 instance (BN254, d=5, RF=8, RP=56) cuts
`transfer.circom` total R1CS constraints by at least 20% and Node proving time by at least 15%.
*(Falsifiable on two numbers: R1CS constraint count and `groth16.fullProve` mean wall-clock.)*

## Threat / privacy model

This experiment changes **how the circuit is compiled and (experimentally) which hash it uses**, not
what is proven. The adversaries and what each observes are unchanged from `docs/threat-model.md`.

- **Chain observer** sees the same public signals (7 / 6 / 5 for transfer / compliance / withdraw)
  and a 128-byte proof. `--O2` removes only *private* linear intermediate wires from the R1CS; the
  public interface, VK size, and proof size are byte-for-byte the same shape. **Leakage delta: none.**
- **Malicious prover** (S2 in the threat model): must not be able to prove a false statement.
  `--O2` is an equivalence-preserving substitution — each eliminated wire is a linear function of
  surviving wires, so the satisfying-assignment set projected on surviving wires is identical.
  Under-constrained-ness is therefore neither introduced nor removed. This is an argument, not a
  proof; the evidence is the existing malicious-witness suites passing on the O2 build (below).
- **Colluding relayer / statistical deanonymiser / malicious auditor / quantum adversary:** unaffected.

**Does NOT defend against / residual surface:** nothing here improves any residual risk. In
particular RR2 (dev-only single-contributor setup) is untouched. Today's measurements used a
**locally generated, dev-only** Powers of Tau (see Approach) — timing-valid, cryptographically
worthless.

**Assumptions:** same Groth16/BN254 assumptions as before. For the Poseidon2 arm we additionally
trust the round constants (HorizenLabs `poseidon2_instance_bn256.rs` for t=3; `@zkpassport/poseidon2`
for t=4) and an **ad-hoc sponge instantiation written for this measurement and not reviewed**
(capacity lane = input length, output = rate lane 1). It must not be treated as a secure hash.

**STRIDE mapping:** S2 (forged proof) and T3 (VK modification) are the only entries touched, and only
through the operational note that **`--O2` changes the R1CS, so the circuit VKs change and the
on-chain VKs must be regenerated at the next ceremony/redeploy** (T3's 1-epoch timelock applies).
No entry changes status.

## Blocked first: on-chain gas (queue item #1)

Spent the start of the run on unblocking, per the queue note. Result: still BLOCKED.

- `sui` CLI: no `sui` binary on PATH; the GitHub release API/download is denied by the session's
  egress proxy (`api.github.com` and `github.com/.../releases` → HTTP 403 on CONNECT/request).
- Direct JSON-RPC against the already-deployed testnet package: `fullnode.testnet.sui.io`,
  `fullnode.mainnet.sui.io`, `sui-testnet-rpc.publicnode.com` → all `403 to CONNECT (policy denial)`
  per `$HTTPS_PROXY/__agentproxy/status`. Not routed around.
- Same proxy also denied `storage.googleapis.com` (Powers of Tau) and `hermez.s3-eu-west-1.amazonaws.com`.

What is missing: either an allow-listed route to a Sui fullnode (to read historical gas via
`suix_queryTransactionBlocks`) or a `sui` binary. Gas is **not estimated** anywhere in this report.
(One thing that *is* known without measuring: `sui::groth16` verification cost depends on the number
of public inputs, not on constraint count, so nothing below changes on-chain gas.)

## Approach

Because gas was blocked, I took queue item #2. Two decisions shaped it:

1. **Measure the existing circuits first, per hash arity.** circom prints non-linear/linear counts.
2. **Build Poseidon2 as a drop-in `Poseidon(n)` template** (`scripts/bench/poseidon2/poseidon2.circom`)
   so the *real* `transfer`/`withdraw`/`compliance` circuits and `merkle_proof.circom` compile
   unmodified except for one `include` line, and the real witness builders produce real proofs.
   The circom permutation is checked against an independent JS implementation on 20 random inputs
   per width (`test-vectors.mjs`: t=3 and t=4 both match).

Poseidon2 widths: only t=3 (2 inputs) and t=4 (rate 3) constants were available offline-reachable.
`Poseidon(2)` → t=3, one permutation. `Poseidon(3)` → t=4, one permutation. `Poseidon(4/5)` → t=4,
**two** permutations (a t=5 instance would need constants generated with the Grain LFSR; not done —
this is the main caveat of the Poseidon2 arm and the reason it is an *upper bound* on Poseidon2 cost
for 4–5-input hashes).

**Control I added mid-run:** the circomlib circuits carry ~7k *linear* constraints in `transfer`
(MDS matrix mixing). circom's default `-O1` keeps them; `--O2` eliminates them by substitution. A
fair comparison needs `--O2` on both arms, so there are four variants per circuit:

| Variant | Hash | circom flag |
|---|---|---|
| `base` | circomlib Poseidon (today's production build) | default (O1) |
| `o2` | circomlib Poseidon | `--O2` |
| `p2` | Poseidon2 shim | default (O1) |
| `p2o2` | Poseidon2 shim | `--O2` |

**Rejected before building:** (a) hand-estimating Poseidon2 constraint counts from round numbers —
rejected, the repo's rule is measure-or-label; (b) porting only the Merkle hasher — rejected, it
would not exercise the 3–5-input domain-tagged hashes, which is where arity matters; (c) generating
t=5 constants — out of budget tonight.

**Environment caveats (read before comparing to `BASELINE.md`):**
- Powers of Tau was **generated locally** (`snarkjs powersoftau new bn128 15` + 1 contribution +
  `prepare phase2`) because the Hermez download was proxy-blocked. Proving time depends on circuit
  structure, not ptau entropy, and every variant here used the *same* ptau, so A/B ratios are valid;
  absolute numbers are not comparable to `BASELINE.md` rows (different machine state — `base`
  transfer measured 984 ms tonight vs 752 ms on 2026-07-22 — hence same-run controls).
- 4 vCPU Intel Xeon @ 2.80GHz, Node v22.22.0, circom 2.2.2 (built from source), snarkjs 0.7.6.
- Node only; browser latency not re-measured.

## Results

**Constraints (circom / snarkjs output, 3 circuits × 4 variants):**

| Circuit | base (prod) | o2 | p2 | p2o2 |
|---|---|---|---|---|
| transfer | 13,611 (6,470 NL + 7,141 L) | **6,384** (−53.1%) | 9,413 | 7,092 |
| withdraw | 3,058 (1,465 + 1,593) | **1,439** (−52.9%) | 2,795 | 2,144 |
| compliance | 12,743 (6,057 + 6,686) | **5,979** (−53.1%) | 8,244 | 6,201 |

**Proving time, Node `groth16.fullProve` incl. witness gen, mean of 20 runs after 1 warm-up (σ in ms):**

| Circuit | base | o2 | p2 | p2o2 |
|---|---|---|---|---|
| transfer | 984.2 (30.4) | **790.8 (48.4)** −19.7% | 869.4 (25.7) −11.7% | 1027.4 (34.7) +4.4% |
| withdraw | 345.2 (24.2) | **292.6 (18.6)** −15.2% | 310.0 (13.3) −10.2% | 383.4 (18.7) +11.1% |
| compliance | 946.8 (38.4) | **746.7 (40.1)** −21.1% | 837.7 (35.7) −11.5% | 948.2 (37.9) +0.1% |

All 12 proofs verified (`verify=true`).

**zkey size (bytes):**

| Circuit | base | o2 | p2 | p2o2 |
|---|---|---|---|---|
| transfer | 6,001,419 | 4,466,607 | 4,712,971 | 9,892,251 |
| withdraw | 1,385,323 | 1,608,143 | 1,361,091 | 2,903,995 |
| compliance | 5,682,143 | 3,785,551 | 4,255,135 | 8,768,575 |

**Per-hash cost (circom, standalone `Poseidon(n)`):**

| n | circomlib NL / L | Poseidon2 NL / L |
|---|---|---|
| 2 | 243 / 274 | 240 / 83 |
| 3 | 264 / 341 | 264 / 92 |
| 4 | 300 / 436 | 528 / 185 (2 perms) |
| 5 | 324 / 511 | 528 / 186 (2 perms) |

**Hypothesis check:** transfer total constraints under the Poseidon2 swap at equal optimisation
(`p2o2` 7,092 vs `o2` 6,384) are **+11.1%**, not −20%; against today's production build (`p2` 9,413
vs `base` 13,611) there *is* a −30.8% drop, but `--O2` alone gives −53.1% with the hash unchanged.
Proving time: `p2o2` is **slower** than `o2` by ~30% (1027 vs 791 ms). Hypothesis **falsified**.

**Why Poseidon2 loses in R1CS:** the S-box dominates both designs (x⁵ = 3 R1CS constraints), and
Poseidon2's linear-layer savings are only a *native-speed* win — R1CS gets linear algebra for free
after `--O2`. Meanwhile Veil's 4- and 5-input hashes cost two permutations at t=4 vs one wider
circomlib permutation, and Poseidon2's dense internal matrix makes `--O2` substitution produce dense
rows (zkey 2.2× bigger for `p2o2`), which slows the prover's MSMs.

**Tests, real Groth16 proofs (`Mode: FULL PROOF`), the existing suites incl. malicious-witness
rejection tests, on both the current build and the `--O2` build:**

```
=============== TESTS on base build ===============
--- transfer.test.mjs
exit=0
Mode: FULL PROOF (snarkjs Groth16)
=== Results: 43 passed, 0 failed ===
--- withdraw.test.mjs
exit=0
Mode: FULL PROOF (snarkjs Groth16)
=== Results: 35 passed, 0 failed ===
--- compliance.test.mjs
exit=0
Mode: FULL PROOF (snarkjs Groth16)
=== Results: 30 passed, 0 failed ===
=============== TESTS on o2 build ===============
--- transfer.test.mjs
exit=0
Mode: FULL PROOF (snarkjs Groth16)
=== Results: 43 passed, 0 failed ===
--- withdraw.test.mjs
exit=0
Mode: FULL PROOF (snarkjs Groth16)
=== Results: 35 passed, 0 failed ===
--- compliance.test.mjs
exit=0
Mode: FULL PROOF (snarkjs Groth16)
=== Results: 30 passed, 0 failed ===
```

Full-suite scope: the three circuit suites (108 tests per build). Move tests and the TS script/frontend
suites were **not run** (no `sui` CLI; no Move or TS code changed).

<details><summary>Raw output of <code>scripts/bench/poseidon2/run.sh 20</code> (ANSI stripped; the
timing lines come from <code>prove-ab.mjs</code>, stdout of the same run)</summary>

```
##### A. micro: constraints per hash arity (circom output) #####
Poseidon(2) circomlib: non-linear=243 linear=274
Poseidon(2) poseidon2: non-linear=240 linear=83
Poseidon(3) circomlib: non-linear=264 linear=341
Poseidon(3) poseidon2: non-linear=264 linear=92
Poseidon(4) circomlib: non-linear=300 linear=436
Poseidon(4) poseidon2: non-linear=528 linear=185
Poseidon(5) circomlib: non-linear=324 linear=511
Poseidon(5) poseidon2: non-linear=528 linear=186
##### B. full circuits (base=circomlib, p2=poseidon2 shim, o2=circomlib + circom --O2, p2o2=poseidon2 + --O2) #####
== base transfer ==
non-linear constraints: 6470
linear constraints: 7141
wires: 13632
[INFO]  snarkJS: # of Constraints: 13611
zkey bytes: 6001419
== o2 transfer ==
non-linear constraints: 6384
linear constraints: 0
wires: 6407
[INFO]  snarkJS: # of Constraints: 6384
zkey bytes: 4466607
== p2 transfer ==
non-linear constraints: 7094
linear constraints: 2319
wires: 9434
[INFO]  snarkJS: # of Constraints: 9413
zkey bytes: 4712971
== p2o2 transfer ==
non-linear constraints: 7092
linear constraints: 0
wires: 7115
[INFO]  snarkJS: # of Constraints: 7092
zkey bytes: 9892251
== base withdraw ==
non-linear constraints: 1465
linear constraints: 1593
wires: 3058
[INFO]  snarkJS: # of Constraints: 3058
zkey bytes: 1385323
== o2 withdraw ==
non-linear constraints: 1439
linear constraints: 0
wires: 1441
[INFO]  snarkJS: # of Constraints: 1439
zkey bytes: 1608143
== p2 withdraw ==
non-linear constraints: 2146
linear constraints: 649
wires: 2795
[INFO]  snarkJS: # of Constraints: 2795
zkey bytes: 1361091
== p2o2 withdraw ==
non-linear constraints: 2144
linear constraints: 0
wires: 2146
[INFO]  snarkJS: # of Constraints: 2144
zkey bytes: 2903995
== base compliance ==
non-linear constraints: 6057
linear constraints: 6686
wires: 12762
[INFO]  snarkJS: # of Constraints: 12743
zkey bytes: 5682143
== o2 compliance ==
non-linear constraints: 5979
linear constraints: 0
wires: 5998
[INFO]  snarkJS: # of Constraints: 5979
zkey bytes: 3785551
== p2 compliance ==
non-linear constraints: 6201
linear constraints: 2043
wires: 8263
[INFO]  snarkJS: # of Constraints: 8244
zkey bytes: 4255135
== p2o2 compliance ==
non-linear constraints: 6201
linear constraints: 0
wires: 6220
[INFO]  snarkJS: # of Constraints: 6201
zkey bytes: 8768575
##### C. proving time (Node, mean of 20 runs, includes witness gen) #####
transfer   base verify=true mean=984.2ms sd=30.4ms min=938.9ms max=1065.5ms
transfer   o2   verify=true mean=790.8ms sd=48.4ms min=726.8ms max=934.9ms
transfer   p2   verify=true mean=869.4ms sd=25.7ms min=811.2ms max=922.4ms
transfer   p2o2 verify=true mean=1027.4ms sd=34.7ms min=962.0ms max=1121.6ms
withdraw   base verify=true mean=345.2ms sd=24.2ms min=308.2ms max=397.0ms
withdraw   o2   verify=true mean=292.6ms sd=18.6ms min=262.3ms max=335.6ms
withdraw   p2   verify=true mean=310.0ms sd=13.3ms min=288.8ms max=331.4ms
withdraw   p2o2 verify=true mean=383.4ms sd=18.7ms min=344.1ms max=420.5ms
compliance base verify=true mean=946.8ms sd=38.4ms min=893.5ms max=1077.8ms
compliance o2   verify=true mean=746.7ms sd=40.1ms min=673.8ms max=832.7ms
compliance p2   verify=true mean=837.7ms sd=35.7ms min=786.4ms max=918.6ms
compliance p2o2 verify=true mean=948.2ms sd=37.9ms min=880.4ms max=1017.5ms
```
</details>

Reproduce:
```
cd circuits && npm ci && cd ../scripts/bench/poseidon2 && npm i
# circom 2.2.x on PATH or $CIRCOM; $HORIZEN_RS = HorizenLabs poseidon2_instance_bn256.rs (see gen-constants.mjs)
CIRCOM=... WORK=/some/dir HORIZEN_RS=... bash scripts/bench/poseidon2/run.sh 20
for t in 3 4; do circom scripts/bench/poseidon2/t/perm$t.circom --r1cs --wasm -o <dir>; done
node scripts/bench/poseidon2/test-vectors.mjs --build <dir with perm3_js, perm4_js> --rs $HORIZEN_RS
```

## Verdict

- **Poseidon2 swap: REJECT.** Loses to a free compiler flag in constraints and in proving time, and
  would force a new hash into the Merkle indexer, relayer and frontend (the Move contracts only store the root as bytes).
  Branch kept; `scripts/bench/poseidon2/` stays as the harness. Rematch conditions: a native-speed
  bottleneck (indexer/tree rebuild, browser witness generation) or a proof system where linear
  algebra is not free (e.g. Plonkish with custom gates).
- **`circom --O2`: KEEP.** Applied to `circuits/scripts/{compile,compile-withdraw,compile-compliance,ceremony}.sh`
  and the CI circuit job. Measured: −53% constraints, −15…−21% Node proving time, all 108 circuit tests
  pass in full-proof mode. **Deploy consequence:** new R1CS ⇒ new zkeys and VKs; the on-chain VKs
  (and anything cached from the old zkeys, e.g. the frontend's `.zkey`) must be regenerated through
  a fresh ceremony and the T3 timelock. Until then the deployed testnet package corresponds to the old build.
  `withdraw`'s zkey grows 16% under O2 (denser rows) — worth watching for browser download size.

## Where this could be used

- The `--O2` finding transfers to **any circom 2.x project that takes circomlib defaults**, most of
  which compile at O1: Tornado-style mixers and Semaphore-based voting/anonymous-credential systems
  are the obvious ones — a ~2× constraint drop for hash-heavy Merkle circuits is a free win there.
- The negative Poseidon2 result is a data point for **thesis chapter on hash choice in R1CS vs
  Plonkish**: Poseidon2's advantage is native/AIR-friendly (STARK-based rollups, Halo2 with custom
  gates), not Groth16-on-R1CS. A confidential-payroll deployment on Sui with a t-of-n auditor board
  stays on Groth16 and should not pay a hash migration for it.
- The A/B harness (`run.sh`: constraints + proving time + verify, per hash and per optimisation
  level) is reusable for the Merkle-depth experiment (queue #4).

## Open questions (tomorrow's queue)

1. **Unblock gas** — needs an egress allow-list entry for a Sui fullnode or a vendored `sui` binary.
   Third failure; consider asking the owner to allow `fullnode.testnet.sui.io` and the Sui release assets.
2. **Is `--O2` + a fresh ceremony deployable with zero frontend change?** Verify the frontend's
   proof path against O2 artifacts end-to-end (browser latency under O2; zkey download size).
3. **Merkle depth is now cheaper to test:** 20 `Poseidon(2)` ≈ 4.9k of transfer's 6.4k non-linear
   constraints. What does depth 24/28 cost under O2? (queue #4)
4. **Can the remaining 6.4k non-linear constraints be cut?** `circom --O2` is exhausted; next lever is
   fewer Merkle levels or a sparser tree structure.
5. A t=5 Poseidon2 instance (Grain-LFSR constants) would shrink the 4–5-input arms; unlikely to
   flip the verdict (≥ 328 NL vs 300–324 circomlib) but it is the open caveat of the `p2` arm.
