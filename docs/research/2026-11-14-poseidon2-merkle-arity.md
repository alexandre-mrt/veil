# Poseidon2 and Merkle arity for Veil's membership proofs

**Date:** 2026-11-14 · **Queue item:** #2 (Poseidon2 vs Poseidon, arity) · **Verdict:** **REJECT**
(Poseidon2), **PARK** (4-ary tree). Two unplanned findings from the same measurements matter more
than the hypothesis itself; see §Findings.

Queue item #1 (on-chain gas) was attempted first and is **BLOCKED for the third time**. Details
in §Item #1 below. Every number in this report comes from a command run on this machine tonight,
with the raw output pasted.

## Hypothesis

> Replacing circomlib Poseidon with Poseidon2 (BN254, t=3) in the depth-20 Merkle membership proof
> cuts `transfer.circom`'s non-linear constraint count by ≥ 10% (baseline: 6,470).

Secondary question, measured in the same run: does a 4-ary tree of depth 10 (same 2^20 capacity,
circomlib `Poseidon(4)`) cut the constraint count and proving time of `transfer` and `compliance`?

**Result:** Poseidon2 cuts `transfer`'s non-linear constraints by **60, or 0.93%**. The hypothesis
is falsified by an order of magnitude.

## Threat / privacy model

**Adversary this work is about:** the **malicious prover**. They try to prove membership of a leaf
that is not in the tree, or to bend the 4-ary position selector so that a leaf they did not commit
to hashes up to the published root. They control every private input and every intermediate signal.
They do not control the root, which is public and checked on-chain against `pool.commitment_root` /
the compliance credential root.

**What the change would defend against, and how:** nothing new. Arity and hash choice are
performance parameters. The security requirement is that they not *weaken* membership soundness.
For the 4-ary template, see the soundness argument below and the negative tests.

**What it does NOT defend against (residual surface):**
- **The chain observer, for transfers.** As of today the transfer Merkle proof provides **no
  anonymity at all** (§Finding 1). So depth, arity and hash change nothing about a transfer's
  anonymity set until that is fixed.
- The admin, who computes the commitment root off-chain and could publish a root containing
  fabricated leaves (STRIDE T4, timelocked, unchanged).
- The trusted setup (RR2). These are Groth16 circuits with a single-contributor dev setup, same as
  production.
- A cryptanalytic break of Poseidon2. Poseidon2 has had less public cryptanalysis than Poseidon.
  Recent algebraic attacks on reduced-round Poseidon/Poseidon2 instances
  have not broken the BN254 t=3 parameters, but the margin is less studied. That is one more reason
  not to adopt it for a ~1% gain.

**Assumptions:** collision resistance of circomlib Poseidon (t=3, t=5) and of HorizenLabs Poseidon2
(t=3) over BN254. Knowledge soundness of Groth16 (dev-only setup, RR2). The admin computes roots
honestly (T4).

**STRIDE mapping:** S2 (forged proof → membership soundness must hold: tested, Q1–Q7). T4
(commitment root is admin-supplied, unchanged). I4 / RR5 (deposit linkability). Tonight's
measurements show this is worse than documented, see §Finding 1. No STRIDE entry changes
because of the Poseidon2/arity variants themselves.

## Approach

Built under `scripts/bench/hash-arity/`. Production circuits are **untouched**:

1. **Poseidon2 in circom** (`circuits/poseidon2.circom`): BN254, t=3, d=5, R_F=8, R_P=56, internal
   diag-1 = [1,1,2]. The round constants are extracted mechanically from the HorizenLabs reference
   (`HorizenLabs/poseidon2@055bde3f`, `poseidon2_instance_bn256.rs`) by
   `gen-poseidon2-constants.mjs`. A BigInt JS reference (`poseidon2.mjs`) reproduces the
   HorizenLabs known-answer vector `Perm([0,1,2])` exactly. The circuit is then checked against that
   JS reference (test P5). Compression: `H(a,b) = Perm([0,a,b])[0]`, the same convention as
   circomlib `Poseidon(2)`, so the two are drop-in comparable.
2. **4-ary Merkle template** (`QuadPlace` + `MerkleQuadPoseidon` in `merkle_variants.circom`):
   2 boolean bits per level select the node's slot among 3 siblings. That costs 11 constraints per
   level for selection plus one `Poseidon(4)`.
3. **Full-circuit variants generated from production source** at bench time, by text
   substitution in `bench.mjs`. This way they track `circuits/*.circom` instead of being forked
   copies:
   - `transfer_quad` and `compliance_quad`: membership swapped to 4-ary depth 10.
   - `transfer_nomerkle`: the C0 membership block removed (public-input layout preserved). It
     exists to price C0 in isolation.
4. For every circuit: compile at `-O1` (what `compile*.sh` uses today: circom's default) **and**
   `-O2`, then Groth16 setup, 1 warm-up, 10 timed `fullProve` runs, and `verify` on every proof.
   `r1cs-density.mjs` counts the non-zero coefficients in A/B/C.

**Alternatives rejected before building:**
- *Poseidon2 for t=5 (to pair with the 4-ary tree).* HorizenLabs ships no BN254 t=5 instance, and
  generating constants myself would make "Poseidon2" an unreviewed parameter set. In R1CS the
  S-box count decides the cost, and for t=5 it is within ~1–2% of `Poseidon(4)`'s, so the t=3
  result already answers the question.
- *Changing the production circuits tonight.* Changing arity also means changing
  `frontend/src/lib/merkle-tree.ts`, `scripts/src/compliance-utils.ts`, the admin's off-chain root
  builder, a new ceremony, and a timelocked VK rotation. None of that is justified by these numbers
  (see Verdict).
- *Rewriting the prover (rapidsnark).* That changes the denominator, not the circuit. It is out of
  scope and noted for the queue.

### Soundness argument: `QuadPlace`

Inputs: `node`, siblings `s0,s1,s2`, bits `b0,b1`. The constraints are `b0(1−b0)=0` and
`b1(1−b1)=0`, so each bit is 0 or 1 over the field (a field-wrapped value like −1 gives
`b(1−b) = −2 ≠ 0`, test Q5). Then `e3 = b0·b1` (constrained), `e1 = b0−e3`, `e2 = b1−e3`,
`e0 = 1−b0−b1+e3` (linear). For each of the 4 boolean assignments, exactly one `e_k` equals 1 and
the rest are 0: (0,0)→e0, (1,0)→e1, (0,1)→e2, (1,1)→e3. The outputs are

```
out0 = s0 + e0(node − s0)          out3 = s2 + e3(node − s2)
out1 = e0·s0 + e1·node + b1·s1     out2 = (1−b1)·s1 + e2·node + e3·s2
```

All intermediate products are `<==` constraints over inputs, so the prover has no free signal.
Substituting the four one-hot cases gives `[node,s0,s1,s2]`, `[s0,node,s1,s2]`, `[s0,s1,node,s2]`
and `[s0,s1,s2,node]`. In every case the output is the sibling list with `node` inserted at slot
`p = b0 + 2·b1`. So a satisfying assignment fixes exactly one ordered 4-tuple per level, and
the root equality reduces membership soundness to collision resistance of `Poseidon(4)`.
Exactly as in the binary template, the path bits are not bound to a leaf index. Veil's nullifiers
do not use the index, so no index-aliasing double-spend exists (the nullifier is
`Poseidon(2, userSecret, epochId, randomnessOld)`).

### Leakage analysis

For the variants as benchmarked, nothing changes for a chain observer. The public inputs are the
same, in the same order, with the same encodings. The root is still an opaque 32-byte value
(`pool.move:78`), and the only thing that differs is the tree shape behind it. Proof size is
constant (128 B compressed Groth16). A 4-ary tree reveals nothing extra on-chain. Off-chain, the
indexer/client serves 3 siblings per level instead of 1 (30 vs 20 field elements per path), which
does not change what the server learns.

### Negative tests (malicious witness rejected)

`node scripts/bench/hash-arity/negative-tests.mjs`. **22/22 pass.** Every rejection fires at the
intended constraint (root equality, or the boolean check for Q2/Q5):

```
PASS  P0  quad d10, node at slot 0 on all 10 levels  (accepted expected, accepted got)
PASS  P1  quad d10, node at slot 1 on all 10 levels  (accepted expected, accepted got)
PASS  P2  quad d10, node at slot 2 on all 10 levels  (accepted expected, accepted got)
PASS  P3  quad d10, node at slot 3 on all 10 levels  (accepted expected, accepted got)
PASS  P4  quad d10, mixed slots  (accepted expected, accepted got)
ERROR:  4 Error in template QuadMember_76 line: 148
PASS  Q1  wrong sibling at level 4  (rejected expected, rejected got)
ERROR:  4 Error in template QuadPlace_0 line: 69
Error in template MerkleQuadPoseidon_75 line: 106
Error in template QuadMember_76 line: 146
PASS  Q2  index bit = 2 at level 2  (rejected expected, rejected got)
ERROR:  4 Error in template QuadMember_76 line: 148
PASS  Q3  level 0: real slot 0, bits claim 1  (rejected expected, rejected got)
  ... (Q3 for every wrong slot at levels 0 and 9: 6 cases, all rejected at line 148)
PASS  Q4  prove a sibling value as the leaf with the same path  (rejected expected, rejected got)
ERROR:  4 Error in template QuadPlace_0 line: 69
Error in template MerkleQuadPoseidon_75 line: 106
Error in template QuadMember_76 line: 146
PASS  Q5  index bit = -1 mod p at level 3  (rejected expected, rejected got)
PASS  V1a valid proof verifies against its own root  (accepted expected, accepted got)
PASS  V1b same proof against root+1  (rejected expected, rejected got)
PASS  P5  Poseidon2 binary d20: circuit accepts root computed by KAT-checked JS reference  (accepted expected, accepted got)
ERROR:  4 Error in template BinaryMemberP2_5 line: 134
PASS  B1  Poseidon2 binary d20: wrong sibling  (rejected expected, rejected got)
PASS  P6  transfer_quad valid witness  (accepted expected, accepted got)
ERROR:  4 Error in template Transfer_150 line: 62
PASS  Q6  transfer_quad: well-formed commitment NOT in tree  (rejected expected, rejected got)
PASS  P7  compliance_quad valid witness  (accepted expected, accepted got)
ERROR:  4 Error in template Compliance_226 line: 70
PASS  Q7  compliance_quad: credential with forged kycLevel not in tree  (rejected expected, rejected got)

ALL CHECKS PASSED
```

```
$ node scripts/bench/hash-arity/poseidon2.mjs
Poseidon2 BN254 t=3 KAT Perm([0,1,2]): PASS
  out[0] = 0x0bb61d24daca55eebcb1929a82650f328134334da98ea4f847f760054f4a3033
  out[1] = 0x303b6f7c86d043bfcbcc80214f26a30277a15d3f74ca654992defe7ff8d03570
  out[2] = 0x1ed25194542b12eef8617361c3ba7c52e660b145994427cc86296242cf766ec8
```

## Results

Machine: 4× Intel Xeon @ 2.30 GHz, Node v22.23.4, circom 2.2.2 (built from source, tag `v2.2.2`),
snarkjs 0.7.6. Locally generated **dev-only pot14** (`powersoftau new bn128 14` + 1 contribution +
`prepare phase2`). The Hermez ptau URL returned HTTP 403 tonight. Proving time does not depend on
which ptau was used. This is a different machine from the 2026-07-22 baseline: production
`transfer` at `-O1` measures 693.7 ms here vs 751.9 ms there. Only compare numbers *within* this
table.

### Single hash (one compression)

| Hash | non-linear | linear | wires |
|---|---|---|---|
| circomlib `Poseidon(2)` (t=3, R_P=57) | 243 | 274 | 520 |
| Poseidon2 t=3 (R_P=56) | 240 | 83 | 326 |
| circomlib `Poseidon(4)` (t=5, R_P=60) | 300 | 436 | 741 |

In R1CS, linear layers are free, so non-linear cost is 3 × #S-boxes: 81 vs 80 for t=3. Poseidon2's
cheaper linear layer is a win for native and PLONKish arithmetisations. It saves almost nothing in
Groth16.

### Merkle membership alone (2^20 leaves), 10 timed proofs each

| Variant | -O1 NL / lin / wires | -O1 nnz | **-O1 prove (ms)** | -O2 NL / wires | -O2 nnz | **-O2 prove (ms)** |
|---|---|---|---|---|---|---|
| binary, Poseidon (production shape) | 4,920 / 5,480 / 10,422 | 32,840 | 551.9 ± 22.9 | 4,860 / 4,882 | 61,060 | 424.8 ± 22.5 |
| binary, Poseidon2 | 4,860 / 1,660 / 6,542 | 57,000 | 405.4 ± 13.4 | 4,860 / 4,882 | 123,460 | 564.4 ± 19.5 |
| 4-ary depth 10, Poseidon(4) | 3,110 / 4,360 / 7,502 | 25,450 | 387.3 ± 12.5 | 3,080 / 3,112 | 76,160 | 383.9 ± 23.5 |

### Full circuits, 10 timed proofs each (all proofs verify)

| Circuit | -O1 NL / wires | -O1 zkey (B) | **-O1 prove (ms)** | -O2 NL / wires | -O2 zkey (B) | **-O2 prove (ms)** |
|---|---|---|---|---|---|---|
| `transfer` (production) | 6,470 / 13,632 | 6,001,419 | **693.7 ± 31.6** | 6,384 / 6,407 | 4,466,607 | **520.7 ± 10.8** |
| `transfer_quad` | 4,660 / 10,712 | 4,910,819 | 595.3 ± 42.4 | 4,604 / 4,637 | 6,088,327 | 538.9 ± 27.3 |
| `transfer_nomerkle` | 1,551 / 3,214 | 1,445,715 | 210.4 ± 4.2 | 1,525 / 1,529 | 1,665,079 | 197.3 ± 4.8 |
| `compliance` (production) | 6,057 / 12,762 | 5,682,143 | **628.7 ± 13.7** | 5,979 / 5,998 | 3,785,551 | **511.8 ± 23.3** |
| `compliance_quad` | 4,247 / 9,842 | 4,591,543 | 573.6 ± 20.0 | 4,199 / 4,228 | 5,407,271 | 493.5 ± 19.9 |

### Deltas

| Comparison | Constraint delta | Proving-time delta |
|---|---|---|
| **Hypothesis:** Poseidon2 vs Poseidon in transfer's tree (NL) | −60 of 6,470 = **−0.93%** | n/a |
| Poseidon2 vs Poseidon membership, both -O1 | −60 NL, −3,820 lin | −26.5% |
| Poseidon2 vs Poseidon membership, both -O2 | 0 | **+32.9%** (slower) |
| Poseidon2 best (-O1) vs Poseidon best (-O2) | — | −4.6% (≈1σ) |
| `transfer_quad` vs `transfer`, -O1 | −1,810 NL (−28.0%) | −14.2% |
| `transfer_quad` vs `transfer`, -O2 | −1,780 NL (−27.9%) | +3.5% (noise) |
| `compliance_quad` vs `compliance`, -O2 | −1,780 NL (−29.8%) | −3.6% (<1σ) |
| **`transfer` -O2 vs -O1 (no source change)** | −7,225 wires (−53%) | **−24.9%**, zkey −25.6% |
| **`compliance` -O2 vs -O1 (no source change)** | −6,764 wires (−53%) | **−18.6%**, zkey −33.4% |
| C0 membership's share of `transfer`, -O1 | 4,919 of 6,470 NL = **76.0%** | 483 of 694 ms = **69.7%** |

**Why constraint count misleads:** at `-O2`, circom substitutes every linear constraint into the
non-linear ones. The A/B/C matrices get denser, and snarkjs's prover cost and zkey size track the
non-zero coefficient count (nnz), not just constraints. Poseidon2's all-to-all linear layers
inline into 2× the nnz of circomlib's (123,460 vs 61,060), which is why identical constraint counts
prove 33% slower. The same effect cancels the 4-ary tree's 28% constraint cut at `-O2`
(nnz 104,066 vs 88,966). This is a measured correlation across eight circuits, not a model.

### Raw output

```
$ node scripts/bench/hash-arity/bench.mjs --ptau /home/user/ptau/pot14_final.ptau --runs 10
=== Veil Merkle hash/arity benchmark (10 timed runs per circuit) ===
node v22.23.4, linux/x64, 4x Intel(R) Xeon(R) Processor @ 2.30GHz
circom: circom compiler 2.2.2, ptau: /home/user/ptau/pot14_final.ptau

--- bin_poseidon_d20 ---
  O1: non-linear 4920, linear 5480, wires 10422 | O2: non-linear 4860, linear 0, wires 4882 | 1 pub / 41 priv
  zkey 4820571 B | prove mean 551.9 ms  sd 22.9  min 519.4  max 590.8 (10 runs) | all proofs verify: true

--- bin_poseidon2_d20 ---
  O1: non-linear 4860, linear 1660, wires 6542 | O2: non-linear 4860, linear 0, wires 4882 | 1 pub / 41 priv
  zkey 3049403 B | prove mean 405.4 ms  sd 13.4  min 384.5  max 426.6 (10 runs) | all proofs verify: true

--- quad_poseidon_d10 ---
  O1: non-linear 3110, linear 4360, wires 7502 | O2: non-linear 3080, linear 0, wires 3112 | 1 pub / 51 priv
  zkey 3205683 B | prove mean 387.3 ms  sd 12.5  min 359.7  max 401.9 (10 runs) | all proofs verify: true

--- transfer ---
  O1: non-linear 6470, linear 7141, wires 13632 | O2: non-linear 6384, linear 0, wires 6407 | 7 pub / 47 priv
  zkey 6001419 B | prove mean 693.7 ms  sd 31.6  min 641.4  max 746.6 (10 runs) | all proofs verify: true

--- transfer_quad ---
  O1: non-linear 4660, linear 6021, wires 10712 | O2: non-linear 4604, linear 0, wires 4637 | 7 pub / 57 priv
  zkey 4910819 B | prove mean 595.3 ms  sd 42.4  min 545.1  max 692.2 (10 runs) | all proofs verify: true

--- transfer_nomerkle ---
  O1: non-linear 1551, linear 1661, wires 3214 | O2: non-linear 1525, linear 0, wires 1529 | 7 pub / 7 priv
  zkey 1445715 B | prove mean 210.4 ms  sd 4.2  min 203.1  max 218.9 (10 runs) | all proofs verify: true

--- compliance ---
  O1: non-linear 6057, linear 6686, wires 12762 | O2: non-linear 5979, linear 0, wires 5998 | 6 pub / 45 priv
  zkey 5682143 B | prove mean 628.7 ms  sd 13.7  min 598.1  max 643.4 (10 runs) | all proofs verify: true

--- compliance_quad ---
  O1: non-linear 4247, linear 5566, wires 9842 | O2: non-linear 4199, linear 0, wires 4228 | 6 pub / 55 priv
  zkey 4591543 B | prove mean 573.6 ms  sd 20  min 540.3  max 610.9 (10 runs) | all proofs verify: true
```

```
$ node scripts/bench/hash-arity/bench.mjs --ptau /home/user/ptau/pot14_final.ptau --runs 10 --prove-opt O2
=== Veil Merkle hash/arity benchmark (10 timed runs per circuit, proving the -O2 R1CS) ===
node v22.23.4, linux/x64, 4x Intel(R) Xeon(R) Processor @ 2.30GHz
circom: circom compiler 2.2.2, ptau: /home/user/ptau/pot14_final.ptau

--- bin_poseidon_d20 ---
  zkey 2935323 B | prove mean 424.8 ms  sd 22.5  min 399.5  max 469.5 (10 runs) | all proofs verify: true
--- bin_poseidon2_d20 ---
  zkey 7193643 B | prove mean 564.4 ms  sd 19.5  min 536  max 594.4 (10 runs) | all proofs verify: true
--- quad_poseidon_d10 ---
  zkey 4294899 B | prove mean 383.9 ms  sd 23.5  min 357.6  max 429 (10 runs) | all proofs verify: true
--- transfer ---
  zkey 4466607 B | prove mean 520.7 ms  sd 10.8  min 507.3  max 544.5 (10 runs) | all proofs verify: true
--- transfer_quad ---
  zkey 6088327 B | prove mean 538.9 ms  sd 27.3  min 489.8  max 589.2 (10 runs) | all proofs verify: true
--- transfer_nomerkle ---
  zkey 1665079 B | prove mean 197.3 ms  sd 4.8  min 191.9  max 207 (10 runs) | all proofs verify: true
--- compliance ---
  zkey 3785551 B | prove mean 511.8 ms  sd 23.3  min 485.7  max 567.1 (10 runs) | all proofs verify: true
--- compliance_quad ---
  zkey 5407271 B | prove mean 493.5 ms  sd 19.9  min 466.8  max 540.7 (10 runs) | all proofs verify: true
```
(The constraint lines of the O2 pass are identical to the O1 pass above and are trimmed here.)

```
$ node scripts/bench/hash-arity/r1cs-density.mjs
circuit              opt constraints   wires     nnzA     nnzB     nnzC  nnzTotal
bin_poseidon2_d20    O1         6520    6542     4920     4860    47220     57000
bin_poseidon_d20     O1        10400   10422     4980     4920    22940     32840
compliance           O1        12743   12762     6401     6057    28427     40885
compliance_quad      O1         9813    9842     4651     4257    24587     33495
quad_poseidon_d10    O1         7470    7502     3230     3120    19100     25450
transfer             O1        13611   13632     6916     6470    30484     43870
transfer_nomerkle    O1         3212    3214     1937     1551     7545     11033
transfer_quad        O1        10681   10712     5166     4670    26644     36480
bin_poseidon2_d20    O2         4860    4882    40340    75700     7420    123460
bin_poseidon_d20     O2         4860    4882     8080    11180    41800     61060
compliance           O2         5979    5998    12466    17996    46812     77274
compliance_quad      O2         4199    4228    28486    51706    12182     92374
quad_poseidon_d10    O2         3080    3112    24100    44890     7170     76160
transfer             O2         6384    6407    16872    26093    46001     88966
transfer_nomerkle    O2         1525    1529     8793    14914     4202     27909
transfer_quad        O2         4604    4637    32892    59803    11371    104066
```

```
$ circom hash_poseidon_2.circom --r1cs -l ../../../../circuits/node_modules -o /tmp/claude-0/hh
non-linear constraints: 243
linear constraints: 274
wires: 520
$ circom hash_poseidon2.circom --r1cs -l ../../../../circuits/node_modules -o /tmp/claude-0/hh
non-linear constraints: 240
linear constraints: 83
wires: 326
$ circom hash_poseidon_4.circom --r1cs -l ../../../../circuits/node_modules -o /tmp/claude-0/hh
non-linear constraints: 300
linear constraints: 436
wires: 741
```

## Findings beyond the hypothesis

### Finding 1: the transfer Merkle proof provides no anonymity (unmitigated, privacy-critical)

`transfer.circom` declares `oldCommitment` a **public** input (`circuits/transfer.circom:132`).
`pool::shielded_transfer` reads it in the clear from `public_inputs_bytes[0..32]`, checks that it
exists as a dynamic field, and **removes it** (`contracts/sources/pool.move:223-229`). It is a
plaintext UTXO key. `zk_withdraw` does the same with its `commitment` (`pool.move:591`). The
consequences:

- A chain observer sees exactly which registered commitment every transfer and withdrawal spends.
  Every `deposit_and_register` → transfer → transfer → … → `zk_withdraw` chain is linked by **exact
  byte equality**. That includes the depositing address at one end and the withdrawal recipient
  and (public) amount at the other. This needs no timing or amount statistics. The anonymity set of a
  transfer is 1.
- `docs/threat-model.md` I4 / RR5 and the controls table ("Anonymity set = all commitments, root
  verified in circuit") overstate this. The membership proof C0 only re-proves something the
  contract already checks: the commitment was registered.
- C0 costs **76.0% of transfer's non-linear constraints and 69.7% of its proving time**
  (`transfer_nomerkle`: 210.4 ms vs 693.7 ms at -O1). Today that cost buys no security property.
  The on-chain `dynamic_field::exists` check already enforces registration, and the circuit's C1
  binds `oldCommitment` to the prover's secret.

Fix directions, in order of how much they change (not measured tonight):
(a) make `oldCommitment` private and spend by nullifier only. This is the Zcash/Tornado shape. The
contract then stops removing commitments by key, and double-spend protection rests on the
nullifier, which must then be deterministic per commitment rather than per epoch: today's
`Poseidon(2, userSecret, epochId, randomnessOld)` lets the same commitment be spent once per epoch
if it is no longer removed. That needs a soundness review of its own.
(b) If linkability is accepted by design, drop C0 and save ~70% of proving time, and correct the
docs.
This report does not change any code or security claim beyond correcting the documentation
(`docs/threat-model.md` I4 / RR5 / controls table now point here).

### Finding 2: compiling with `-O2` is a free −25% on transfer proving time

`circuits/scripts/compile*.sh` invoke circom without an optimisation flag (default `-O1`). With
the source unchanged, `-O2` cuts `transfer` proving from 693.7 to **520.7 ms (−24.9%)** and
`compliance` from 628.7 to **511.8 ms (−18.6%)**, and shrinks both zkeys by a quarter to a third.
That is a bigger win than either tonight's hash or arity variant. It is not adopted here because
adopting it means a new ceremony, a timelocked VK rotation on the pool, re-running all 108
circuit tests against `-O2` artifacts, a browser re-bench, and the Move suite (blocked). That is a
separate PR with its own verdict, queued as the next experiment.

## Verdict

- **Poseidon2: REJECT.** Measured: **−0.93%** of transfer's non-linear constraints against a ≥10%
  bar. Its `-O1` proving-time advantage (−26.5%) disappears entirely against plain `-O2` Poseidon
  (best vs best −4.6%, within one standard deviation) and turns into a 33% loss at `-O2`. On top of
  that it brings a less-studied permutation and no circomlib/circomlibjs/Sui-native support.
  The knowledge survives in `scripts/bench/hash-arity/`.
- **4-ary depth-10 tree: PARK.** A real −28% non-linear constraint cut, but proving-time gains only
  show up at `-O1` (−14% transfer, −9% compliance). At `-O2`, which Finding 2 says Veil should be
  using, it is within noise. It is blocked on (i) Finding 2 being decided, and (ii) Finding 1: for
  transfers, the tree's shape is irrelevant while `oldCommitment` is public. Worth revisiting
  for the compliance credential tree (which does hide its leaf) under a prover that is less
  nnz-sensitive than snarkjs (rapidsnark), and at depth > 20.
- `BASELINE.md`: not updated with any new production number (no production change merged). The
  gas row is updated to record tonight's third blocked attempt and the exact unblock path.

## Item #1 (on-chain gas): BLOCKED, attempt 3

What was tried tonight, in order:
1. `api.github.com` release listing for `MystenLabs/sui`: HTTP 403 (repository not in this
   session's GitHub scope; anonymous git clone is allowed, release assets are not).
2. Direct JSON-RPC to `https://fullnode.testnet.sui.io:443`: `curl: (56) CONNECT tunnel failed,
   response 403` (egress proxy).
3. Docker Hub registry *is* reachable. The `mysten/sui-tools:testnet` manifest was read
   (build-date 2026-11-06, git-revision `9dc25070cf2e`; the `sui` binary is layer
   `sha256:f51aad7c…`, 67 MB). Downloading and running that layer was **denied by the session's
   permission layer** and was deliberately not retried or worked around.
4. Building from source (`cargo build --release -p sui`) is still possible in principle (4 cores,
   ~31 GB free) but did not fit tonight's budget alongside a measured experiment.

**To unblock (one of):** approve fetching the official `mysten/sui-tools` image layer for this
routine; or allowlist `fullnode.testnet.sui.io` in the environment's network policy (then
`suix_queryTransactionBlocks` on the deployed package gives historical gas with no CLI); or
dedicate a night to a from-source build.

## Where this could be used

- **Any Groth16 + circom + snarkjs deployment choosing a hash:** Tornado-style pools, Semaphore
  groups, zkLogin-style credential circuits. The result is general. Poseidon2's advantage is a
  native/PLONKish advantage, and in R1CS under snarkjs it is neutral (-O1) or harmful (-O2) once
  density is counted. A useful negative result for a thesis chapter on *arithmetisation-aware
  primitive selection*: "fewer constraints" and "faster prover" diverge once the R1CS
  optimiser runs.
- **Compliance credential registries with large issuer sets** (e.g. a KYC registry of 10^6–10^7
  credentials on Sui): the 4-ary template is a measured, soundness-argued drop-in. At depth 12
  (16.7 M leaves) it would cost 12 × 311 = 3,732 NL vs binary depth 24's 24 × 246 = 5,904
  (arithmetic from the measured per-level costs, not a separate run).
- **Audit methodology:** the `transfer_nomerkle` pricing trick (strip one constraint block, keep
  the public-input layout, re-prove) is a cheap way to find which part of a privacy circuit pays
  for which guarantee. Here it showed that 70% of the prover's time pays for no property.

## Open questions → tomorrow's queue

1. **Transfer linkability (Finding 1).** Design + measure option (a), private `oldCommitment` with
   per-commitment nullifiers, with a soundness argument for double-spend protection without UTXO
   key removal. Or decide (b) and drop C0.
2. **Adopt `-O2` (Finding 2).** Rebuild with `-O2`, run all 108 circuit tests and the negative
   tests on `-O2` artifacts, browser re-bench, VK rotation plan. Expected −19 to −25% proving time.
3. Is the nnz sensitivity specific to snarkjs? Re-run `bench.mjs` artifacts through rapidsnark
   (C++ prover) to see whether the 4-ary tree's constraint cut comes back as a proving-time cut.
4. On-chain gas (blocked three times): see the unblock paths above.
5. `withdraw.circom` has **no** Merkle membership at all. Its `commitment` is public, as with
   transfers, so it is consistent today, but option (a) of Q1 must add one there too.
