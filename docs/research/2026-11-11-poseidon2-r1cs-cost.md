# 2026-11-11: Poseidon2 vs circomlib Poseidon in Veil's R1CS (queue item #2)

**Verdict: REJECT.** Poseidon2 does not reduce Veil's Groth16 cost. Two findings came out of
the controls, and both matter more than the hypothesis did:

1. **Compiling with `circom --O2` cuts `transfer.circom` from 13,611 to 6,384 constraints and its
   proving time by 22–25%, with no change to the protocol.** The 108 real-proof circuit tests still
   pass. This is now queue item #2.
2. **Privacy flaw, not caused by tonight's work:** `oldCommitment` (transfer) and `commitment`
   (withdraw) are *public* inputs, and `pool.move` consumes them by exact key. The depth-20 Merkle
   membership proof therefore hides nothing. A chain observer can link deposit address → every
   later transfer → withdrawal recipient. `docs/threat-model.md` listed the Merkle accumulator as a
   working anonymity-set control (I4, RR5, controls table). This report corrects that and adds
   **I7**. It is now queue item #1.

Queue item #1 (on-chain gas) was attempted first and is **BLOCKED** for the third time. See
"Why not queue item #1" below.

## Hypothesis

Replacing circomlib Poseidon with Poseidon2 (BN254, t=3) in the depth-20 Merkle path cuts
`transfer.circom`'s R1CS constraint count, and with it Node Groth16 proving time, by at least 10%.

This can be falsified at two levels: the constraint count (`circom` output) and the proving time
(`snarkjs groth16.fullProve`, mean of 10 runs).

## Threat / privacy model

**What a hash swap protects against.** Nothing new. Poseidon and Poseidon2 make the same security
claim (128-bit collision and preimage resistance for an algebraic hash over BN254). Swapping them
does not change what a chain observer, relayer, auditor or malicious prover can do. The question
tonight was purely about cost. The adversaries that matter are the ones a hash change could
**introduce**:

- **Malicious prover (soundness).** A new circom permutation that is wrong or under-constrained
  would let a prover claim a Merkle root they cannot open. Defences built tonight:
  - the circom template must reproduce the published HorizenLabs known-answer vector;
  - a witness with one output tampered must violate the R1CS;
  - a witness whose root was computed with the *other* hash must be rejected (otherwise
    cross-hash confusion in the indexer becomes a soundness bug).
  All three pass (see Results).
- **Chain observer.** A hash swap changes no public input and no event, so the observer learns
  nothing new.

**Residual surface (what this does NOT defend against), stated bluntly.** The Merkle path
currently buys **no anonymity at all**:

- `transfer.circom:33` declares `oldCommitment` public, and it is the Merkle leaf
  (`transfer.circom:56`).
- `pool.move` (`shielded_transfer`) then reads public-input bytes 0..32 and removes that exact
  `CommitmentKey` from the pool. `zk_withdraw` does the same with its public `commitment`.
- So every transfer publicly names the commitment it spends, and `TransferEvent` names the one it
  creates.
- `deposit_and_register` publishes the genesis commitment from the depositor's address.

An observer can therefore rebuild each user's full chain:
deposit address → c₀ → c₁ → … → withdrawal recipient. The number of transfers and their timing
are visible. Amounts stay hidden inside the commitments. Relayer sender-hiding (I3) only hides the
gas payer, not this graph.

**Assumptions.**
- Poseidon2 security per eprint 2023/323, with the HorizenLabs BN254 t=3 parameters (RF=8, RP=56).
- Groth16 knowledge soundness.
- Tonight's ptau is a **local single-contributor dev ceremony**, generated with
  `snarkjs powersoftau new bn128 15` + one contribution, because the Hermez pot15 download returns
  403 here. It is fine for timing (proving cost does not depend on who contributed) and must never
  be used for anything else. Same caveat as RR2.

**STRIDE mapping.**
- S2 (forged proof): the new-template soundness checks above.
- T4 (Merkle root manipulation): unchanged.
- **I4 / RR5 / controls table: corrected.** They claimed "Merkle accumulator provides anonymity
  set", which is false as wired.
- **New I7:** transaction-graph linkability through public spent commitments. Status: Open.

## Approach

**Built:**
- Poseidon2 t=3 as a BigInt JS reference (`scripts/bench/poseidon2/poseidon2.mjs`). It matches the
  HorizenLabs KAT for `permute([0,1,2])`.
- The same permutation as a circom template (`circuits/research/poseidon2.circom`). Constants are
  generated from one JSON file shared with the JS twin. S-boxes are 3 constraints each; linear
  layers are carried in `var`s, so they cost zero constraints.
- `MerkleProofP2(20)` and `transfer_p2.circom`. The bench script generates the latter with `sed`
  and diffs it against `transfer.circom`, to prove that the only change is the Merkle hasher.
- Benchmarks:
  - `scripts/bench/poseidon2-r1cs.sh`: per-component constraint counts, run under default flags
    and under `--O2`.
  - `scripts/bench/poseidon2-prove.mjs`: Groth16 proving time for 4 builds, plus proof verification
    and the cross-hash negative test.
  - `scripts/bench/poseidon2/r1cs-density.mjs`: non-zero coefficient count, added to explain an
    anomaly in the timings.

**Rejected before building:**
- **Poseidon2 at t=4/5/6 for the commitment and nullifier hashes.** No audited BN254 constants
  exist for those widths, and generating my own would make any result about my constants, not
  about Poseidon2. Since the Merkle path (20 × Poseidon(2)) is 76% of transfer's non-linear
  constraints, t=3 is where the answer is decided anyway.
- **A feed-forward compression mode instead of the sponge layout.** It costs the same in R1CS, and
  matching circomlib's `[0, a, b] → out[0]` layout keeps the comparison like-for-like.

**The control that decided it.** Default circom (what `compile*.sh` and CI use) keeps linear
constraints. My Poseidon2 has almost none, because of the `var`s. That makes the default-flags
comparison unfair, so every count is repeated under `--O2`, which substitutes linear constraints
away in both builds.

## Results

Machine: 4 × Intel Xeon @ 2.10 GHz, Node v22.23.4, circom 2.2.3 (installed with the exact `cargo
install` line from `.github/workflows/ci.yml`), snarkjs 0.7.6. Proving times are mean of 10 runs
after one warm-up, from two separate runs. Compare within this table only: absolute times are
~15% above `BASELINE.md`'s July numbers on a different machine and load.

### Constraints

| Component | default: total / non-linear / linear | `--O2`: total (all non-linear) |
|---|---|---|
| circomlib Poseidon(2) | 517 / 243 / 274 | **240** |
| Poseidon2 t=3 hash2 | 323 / 240 / 83 | **240** |
| circomlib Poseidon(3) / (4) / (5) | 605 / 736 / 835 | 261 / 297 / 321 |
| MerkleProof(20), Poseidon | 10,400 / 4,920 / 5,480 | 4,860 |
| MerkleProof(20), Poseidon2 | 6,520 / 4,860 / 1,660 | 4,860 |
| **transfer.circom** | **13,611** / 6,470 / 7,141 (= BASELINE.md ✓) | **6,384** |
| transfer_p2 | 9,731 / 6,410 / 3,321 | 6,384 |

**Poseidon2 saves exactly 0 constraints under `--O2`, and 3 non-linear constraints per hash
(−1.2%) under default flags.** This is expected in hindsight. Poseidon2's improvement is a cheaper
linear layer, and in R1CS a linear combination costs nothing. The S-box count (8×3 + 56 = 80 vs
8×3 + 57 = 81) is all that remains, and circomlib's optimised Poseidon already absorbs that one
extra round.

### Proving time, R1CS density, artifact size (transfer.circom)

| Build | Constraints | Wires | Non-zeros (A+B+C) | zkey | Run 1 mean (σ) | Run 2 mean (σ) |
|---|---|---|---|---|---|---|
| Poseidon, default (**today's production build**) | 13,611 | 13,632 | 43,870 | 6,001,431 B | 868.2 ms (47.4) | 911.4 ms (62.2) |
| Poseidon2, default | 9,731 | 9,752 | 68,030 | 4,754,551 B | 873.6 ms (72.6) | 841.6 ms (68.4) |
| **Poseidon, `--O2`** | **6,384** | **6,407** | 88,966 | 4,466,619 B | **651.9 ms (20.2)** | **707.2 ms (50.9)** |
| Poseidon2, `--O2` | 6,384 | 6,407 | 151,366 | 8,724,939 B | 880.5 ms (44.7) | 870.0 ms (47.2) |

All 40 timed proofs verified against their own VK. The cross-hash negative test rejected every
build.

**How to read the timings:**
- **Poseidon2 under default flags:** +0.6% in run 1, −7.7% in run 2. Both are within one σ, so
  there is no measurable gain. It has 28% fewer constraints and wires, but 55% more non-zeros, and
  both builds sit in the same 2^14 FFT domain.
- **`--O2`:** −25% in run 1 and −22% in run 2, each 3–4 σ. Wires halve and the FFT domain drops
  from 2^14 to 2^13, even though non-zeros double.
- **Poseidon2 + `--O2`:** substituting my `var`-carried linear layers back in produces dense rows
  (151k non-zeros, 2× the zkey), which wipes out the gain.

The working model is that snarkjs cost tracks domain size, wires and non-zeros together, not the
constraint count alone. It is **consistent with** these four points but **not isolated** here;
that is an open question below.

### `--O2` soundness spot-check (all three circuits, full-proof mode)

| Circuit | default constraints → `--O2` | FFT domain | Existing test file under `--O2` |
|---|---|---|---|
| transfer | 13,611 → 6,384 | 2^14 → 2^13 | 43 passed, 0 failed |
| compliance | 12,743 → 5,979 | 2^14 → 2^13 | 30 passed, 0 failed |
| withdraw | 3,058 → 1,439 | 2^12 → 2^11 | 35 passed, 0 failed |

These suites include the adversarial cases: range overflows, alias checks, tampered public and
private inputs, and domain-tag separation.

### Raw output

`bash scripts/bench/poseidon2-r1cs.sh` (run from `circuits/`):

```
JS reference KAT: PASS
transfer_p2.circom differs from transfer.circom only in the Merkle hasher
circom: circom compiler 2.2.3   flags: <default>
circuit        constraints  nonlinear     linear    wires
p1_hash2              517        243        274      520
p2_hash2              323        240         83      326
p1_hash3              605        264        341      609
p1_hash4              736        300        436      741
p1_hash5              835        324        511      841
p1_merkle20         10400       4920       5480    10422
p2_merkle20          6520       4860       1660     6542
transfer            13611       6470       7141    13632
transfer_p2          9731       6410       3321     9752
p2_perm3_kat          323        240         83      327
circom Poseidon2Perm3([0,1,2]) == HorizenLabs KAT: PASS
honest witness satisfies R1CS: PASS
NEGATIVE: tampered out[0]+1 rejected by R1CS: PASS (rejected)
```

`OPT=--O2 bash scripts/bench/poseidon2-r1cs.sh`:

```
JS reference KAT: PASS
transfer_p2.circom differs from transfer.circom only in the Merkle hasher
circom: circom compiler 2.2.3   flags: --O2
circuit        constraints  nonlinear     linear    wires
p1_hash2              240        240          0      243
p2_hash2              240        240          0      243
p1_hash3              261        261          0      265
p1_hash4              297        297          0      302
p1_hash5              321        321          0      327
p1_merkle20          4860       4860          0     4882
p2_merkle20          4860       4860          0     4882
transfer             6384       6384          0     6407
transfer_p2          6384       6384          0     6407
p2_perm3_kat          240        240          0      244
circom Poseidon2Perm3([0,1,2]) == HorizenLabs KAT: PASS
honest witness satisfies R1CS: PASS
NEGATIVE: tampered out[0]+1 rejected by R1CS: PASS (rejected)
```

`node scripts/bench/poseidon2-prove.mjs --runs 10`, run 1. Each `ERROR: 4 … line: 61` line is the
witness generator rejecting the cross-hash negative-test witness at the Merkle root check
(`transfer.circom:61`), as intended.

```
=== transfer.circom proving time: Poseidon vs Poseidon2 Merkle, default vs --O2 (10 runs) ===
node v22.23.4, linux/x64, ptau /home/user/veil/circuits/research/ptau/pot15_final.ptau

ERROR:  4 Error in template Transfer_220 line: 61

--- transfer    (Poseidon,  default flags) ---
  constraints 13611, wires 13632, zkey 6001431 B, vk 3582 B
  mean 868.2 ms  sd 47.4  min 798.3  max 957.8
  proof verifies: true   NEGATIVE cross-hash root rejected: true

ERROR:  4 Error in template Transfer_153 line: 61

--- transfer_p2 (Poseidon2, default flags) ---
  constraints 9731, wires 9752, zkey 4754551 B, vk 3587 B
  mean 873.6 ms  sd 72.6  min 754.8  max 969.2
  proof verifies: true   NEGATIVE cross-hash root rejected: true

ERROR:  4 Error in template Transfer_220 line: 61

--- transfer    (Poseidon,  --O2) ---
  constraints 6384, wires 6407, zkey 4466619 B, vk 3582 B
  mean 651.9 ms  sd 20.2  min 614.7  max 678.4
  proof verifies: true   NEGATIVE cross-hash root rejected: true

ERROR:  4 Error in template Transfer_153 line: 61

--- transfer_p2 (Poseidon2, --O2) ---
  constraints 6384, wires 6407, zkey 8724939 B, vk 3583 B
  mean 880.5 ms  sd 44.7  min 792.4  max 936.4
  proof verifies: true   NEGATIVE cross-hash root rejected: true
```

Run 2 (same command, zkeys reused; `grep -E "^---|mean|verifies"`):

```
--- transfer    (Poseidon,  default flags) ---
  mean 911.4 ms  sd 62.2  min 820  max 988.6
  proof verifies: true   NEGATIVE cross-hash root rejected: true
--- transfer_p2 (Poseidon2, default flags) ---
  mean 841.6 ms  sd 68.4  min 707.5  max 932.5
  proof verifies: true   NEGATIVE cross-hash root rejected: true
--- transfer    (Poseidon,  --O2) ---
  mean 707.2 ms  sd 50.9  min 655.3  max 805.8
  proof verifies: true   NEGATIVE cross-hash root rejected: true
--- transfer_p2 (Poseidon2, --O2) ---
  mean 870 ms  sd 47.2  min 801.7  max 968.4
  proof verifies: true   NEGATIVE cross-hash root rejected: true
```

`node scripts/bench/poseidon2/r1cs-density.mjs circuits/research/build{,-O2}/{transfer,transfer_p2,p1_hash2,p2_hash2}.r1cs`:

```
build/transfer.r1cs            constraints  13611  nnz A    6916  B   6470  C  30484  total   43870
build/transfer_p2.r1cs         constraints   9731  nnz A    6856  B   6410  C  54764  total   68030
build-O2/transfer.r1cs         constraints   6384  nnz A   16872  B  26093  C  46001  total   88966
build-O2/transfer_p2.r1cs      constraints   6384  nnz A   49132  B  90613  C  11621  total  151366
build/p1_hash2.r1cs            constraints    517  nnz A     243  B    243  C   1143  total    1629
build/p2_hash2.r1cs            constraints    323  nnz A     240  B    240  C   2357  total    2837
build-O2/p1_hash2.r1cs         constraints    240  nnz A     398  B    556  C   2086  total    3040
build-O2/p2_hash2.r1cs         constraints    240  nnz A    2011  B   3782  C    367  total    6160
```

`--O2` spot-check: each circuit rebuilt with `circom <c>.circom --r1cs --wasm --sym --O2 -o build
-l node_modules`, followed by the CI setup/contribute/export sequence, then
`node --experimental-vm-modules test/<c>.test.mjs`:

```
== transfer --O2
non-linear constraints: 6384
linear constraints: 0
Mode: FULL PROOF (snarkjs Groth16)
=== Results: 43 passed, 0 failed ===
== compliance --O2
non-linear constraints: 5979
linear constraints: 0
wires: 5998
Mode: FULL PROOF (snarkjs Groth16)
=== Results: 30 passed, 0 failed ===
== withdraw --O2
non-linear constraints: 1439
linear constraints: 0
wires: 1441
Mode: FULL PROOF (snarkjs Groth16)
=== Results: 35 passed, 0 failed ===
```

### Full suite, as in `.github/workflows/ci.yml`

| Job | Result |
|---|---|
| circuit-tests (`npm test`, default build, CI sequence, full-proof mode) | transfer 43/43, compliance 30/30, withdraw 35/35 |
| script-tests (`test-converter.ts`, `test-compliance-utils.ts`, `fuzz-tests.ts`) | 109 passed, 67 passed, "ALL 6 PROPERTIES PASSED" |
| frontend-tests (`tsc --noEmit`, `biome check .`, `vitest run`) | exit 0, exit 0, 19/19 |
| move-tests (`sui move test`) | **NOT RUN.** No `sui` binary (see below). No Move code changed. |

No production circuit, contract or frontend file changed tonight. The new circom code lives only
under `circuits/research/` and is not included by any production circuit.

### Why not queue item #1 (on-chain gas): BLOCKED, third time, with a precise reason

What was tried, in order:
- `api.github.com` and GitHub release downloads (CI's own install path): HTTP 403 from the
  sandbox proxy.
- `fullnode.testnet.sui.io`: CONNECT 403.
- `git ls-remote` against `MystenLabs/sui` works. It confirmed that `contracts/Move.lock`'s
  framework rev `94ad8ccd…` is tag `testnet-v1.72.1`.
- A shallow clone + `cargo build --release --bin sui` of that tag was **denied by the session's
  permission layer** ("code from external"). Not retried.

Unblocking this needs one of:
- the environment's network policy allowing `github.com/MystenLabs/sui/releases/*` or a Sui
  fullnode; or
- an explicitly pre-authorised `sui` source build in the routine's environment setup script.

## Verdict: **REJECT** (Poseidon2)

Poseidon2's advantage lives in native execution and in Plonkish linear layers. In R1CS, linear
layers are free, so the advantage disappears. What it would cost Veil:
- a new indexer and client hash;
- a hand-rolled, unaudited circom template;
- denser constraints under `--O2`;
- a full VK rotation.

What it would buy: 0 constraints under `--O2`, and no measurable proving-time change under the
current flags. The research template and benches stay in the tree, so a Plonkish port (queue #10)
can reuse them.

`BASELINE.md` is unchanged: no protocol change was kept. Its proving-time rows were not re-stated
because tonight's machine differs; the like-for-like comparison is the table above.

## Where this could be used

- **Any circom/Groth16 protocol weighing a Poseidon2 migration**, such as Tornado-style mixers,
  Semaphore-style group membership, or zk-email-style attestations. In R1CS the expected gain is
  ~1% non-linear. If the motivation is prover time, change the compile flags first.
- **The `--O2` result applies to every circom deployment still built with default flags**,
  including Veil's `compile*.sh` and CI. It is a free 2× constraint reduction, and it needs a VK
  rotation, not a redesign.
- **Thesis chapter "cost models for SNARK circuit optimisation":** constraint count is a misleading
  proxy. Two builds with identical constraint counts (6,384) differ by 23–35% in proving time and 2×
  in zkey size, because of R1CS density.
- **The linkability finding generalises** to any "commitment chain" design that publishes the
  spent note and also checks Merkle membership. A Sui confidential-payroll pool would leak the
  employer → employee payment graph even with amounts hidden.

## Open questions → tomorrow's queue

1. **Make the Merkle membership load-bearing.** Make `oldCommitment` private, spend by nullifier
   only, and stop keying `CommitmentKey` by the spent commitment. This is the real fix for I7. It
   touches `transfer.circom`, `withdraw.circom`, `pool.move` and the indexer. It needs a soundness
   argument for double-spend prevention by nullifier alone (the nullifier must be unique per note:
   check `Poseidon(2, userSecret, epochId, randomnessOld)` against note reuse across epochs).
2. **Adopt `--O2` in `compile*.sh` and CI.** Then re-measure Node and browser proving for all three
   circuits on one machine, and plan the timelocked on-chain VK rotation. Also isolate the cost
   model: is it the FFT-domain halving, the wire count, or both?
3. Does a signal-materialised Poseidon2 template (sparse rows) recover the density loss under
   `--O2`? This only matters if a Plonkish backend is ever adopted.
4. **Native hashing throughput for the indexer** (Merkle tree rebuild at 10^6 leaves): is this
   where Poseidon2 actually pays off? Fold into queue item #5 (Merkle at scale).
