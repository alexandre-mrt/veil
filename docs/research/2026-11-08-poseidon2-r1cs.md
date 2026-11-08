# 2026-11-08 — Poseidon2 vs Poseidon in Veil's R1CS (queue item #2)

Queue item #1 (on-chain gas) was attempted first and is **BLOCKED** a third time — see
"Gas attempt" at the end and the separate LEDGER row. This report is the fallback measured
experiment, item #2.

## Hypothesis

Replacing circomlib Poseidon with Poseidon2 (BN254, d=5, R_F=8, R_P=56) in `transfer.circom`
(Merkle path + the four leaf-style hashes) cuts its **non-linear R1CS constraints by ≥10%**
(baseline 6,470) and Groth16 proving time by ≥10% (baseline ≈750–820 ms in Node).

## Threat / privacy model

Not a new-feature experiment: the adversary model is unchanged. The relevant adversaries are the
same as for the existing hash: a **malicious prover** (must not forge membership, nullifiers or
commitments) and a **chain observer** (must learn nothing beyond public inputs).

- *Soundness argument.* Poseidon2 is used as a drop-in 2-to-1 / fixed-arity hash with the tag in the
  capacity slot. The circuit still enforces every constraint of `transfer.circom` (C0–C11); only
  the hash gadget differs. Binding of each hash relies on collision resistance of the Poseidon2
  permutation (HorizenLabs reference parameters, 128-bit target) — a *different, younger* assumption
  than Poseidon's (Poseidon2 has had less cryptanalysis). Domain separation actually improves: the
  tag moves from a rate input into the capacity (a constant, never prover-controlled), so tag
  confusion cannot be induced by choosing data inputs. Negative tests below confirm tag swaps are
  rejected.
- *Leakage.* Public inputs and their order are identical (7 public signals), so a chain observer
  learns exactly what they learn today. Nothing new is revealed.
- *Does NOT defend against / residual:* no change to RR2 (dev trusted setup), RR5 (deposit
  linkability), or the quantum exposure of BN254. Switching hash invalidates every existing
  commitment/Merkle tree (full migration + new ceremony). STRIDE: touches T-series tampering rows
  (T1/T3 proof/VK integrity) only in that a new VK would be required; no row changes status.
- *Assumptions:* Groth16/BN254 as before; Poseidon2 security margin per the reference parameters;
  my reference implementation is a BigInt port of HorizenLabs `poseidon2.rs` and **has no external
  BN254 known-answer test** available offline (the Horizen repo only ships Goldilocks/BabyBear KATs),
  so circuit == my port is verified (below) but port == spec is only by code review.

## Approach

Built (all under `circuits/experiments/poseidon2/`, nothing in production circuits touched):
`poseidon2.circom` (Poseidon2Perm for t=3,4; hash wrappers), `merkle_proof_p2.circom`, two
`transfer` variants — **merkle** (only the depth-20 path hashes swapped) and **all** (path +
`oldHash/newHash/nfHash` as t=4 with tag in capacity + `txHash` as t=3). Constants are extracted as
data by `scripts/bench/poseidon2/gen-constants.mjs` (t=3 from HorizenLabs/poseidon2 @ 055bde3f; t=4
from npm @zkpassport/poseidon2 0.6.2 — t=4 provenance is a third party, not the Horizen repo).

Rejected before building: porting Poseidon2 t=5 (no standardised t=5 instance); a Poseidon2 sponge
with multiple permutations for 4-input hashes (more constraints, defeats the point); changing Merkle
arity in the same night (second hypothesis — queued instead).

Tooling: `circom2` 0.2.23 (npm WASM build of circom 2.x) — building circom from cloned source was
denied by the sandbox this run. Sanity check: it reproduces the shipped constraint counts exactly
(6,470 / 7,141 for transfer, 1,465 / 1,593 withdraw, 6,057 / 6,686 compliance).

## Results

Constraint counts (circom default `--O1`, as shipped by `compile.sh`):

| Circuit | Non-linear | Linear | Total | vs baseline |
|---|---|---|---|---|
| Poseidon(2) circomlib (t=3) | 243 | 274 | 517 | — |
| Poseidon2 t=3 | 240 | 275 | 515 | -0.4% |
| Poseidon(4) circomlib (t=5) | 300 | 436 | 736 | — |
| Poseidon2 t=4 (3 inputs + capacity tag) | 264 | 348 | 612 | -16.8% |
| **transfer (baseline)** | **6,470** | 7,141 | 13,611 | — |
| transfer, Merkle path → Poseidon2 | 6,410 | 7,161 | 13,571 | -0.3% |
| **transfer, all hashes → Poseidon2** | **6,278** | 6,831 | 13,109 | **-3.0% non-linear, -3.7% total** |

With `--O2` (full linear substitution) the non-linear-only picture is the same: baseline 6,384,
Merkle-only 6,384 (**0.0%**), all 6,276 (-1.7%).

Proving time, same process, 15 interleaved runs (A,B,A,B…), Node v22.23.4, 4-core sandbox,
`fullProve` = witness + prove, dev-only pot15 generated locally:

| | mean ms | σ | min | zkey bytes |
|---|---|---|---|---|
| transfer (baseline) | 816.2 | 31.5 | 757.0 | 6,001,417 |
| transfer_p2_all | 756.8 | 43.7 | 666.2 | 5,823,881 |

Ratio 0.927 (-7.3%); the gap is ~1.5σ of either series — real-looking but small, and entirely
explained by the -3.7% constraint reduction plus noise. (Absolute baseline differs from BASELINE.md's
751.9 ms: different run, different ptau/zkey; only the interleaved ratio is meaningful.)

Correctness / negative tests (`equivalence.mjs`, O1 and O2 both 29/29): 20 random vectors circuit ==
reference; valid transfer witness accepted; rejected at witness generation: wrong root, wrong
sibling, non-boolean path index, forged nullifier, forged oldCommitment, cumulativeNew ≠ old+tx,
txAmountHash under wrong tag, commitment under nullifier tag. Output:

```
perm([0,1,2]) t=3 [0] = 0xbb61d24daca55eebcb1929a82650f328134334da98ea4f847f760054f4a3033
PASS  valid transfer witness accepted
PASS  rejected: wrong merkleRoot
PASS  rejected: wrong sibling in path
PASS  rejected: non-boolean pathIndex (2)
PASS  rejected: forged nullifier
PASS  rejected: forged oldCommitment (not in tree / not well-formed)
PASS  rejected: cumulativeNew != cumulativeOld + txAmount
PASS  rejected: tag confusion: txAmountHash computed under tag 2
PASS  rejected: commitment hashed with nullifier tag (domain swap)
29 passed, 0 failed
```

Constraint output (raw):

```
######## optimisation --O1
== micro_poseidon_t3
non-linear constraints: 243
linear constraints: 274
== micro_poseidon2_t3
non-linear constraints: 240
linear constraints: 275
== micro_poseidon_t5
non-linear constraints: 300
linear constraints: 436
== micro_poseidon2_t4
non-linear constraints: 264
linear constraints: 348
== transfer
non-linear constraints: 6470
linear constraints: 7141
== transfer_p2_merkle
non-linear constraints: 6410
linear constraints: 7161
== transfer_p2_all
non-linear constraints: 6278
linear constraints: 6831
######## optimisation --O2
== micro_poseidon_t3
non-linear constraints: 240
linear constraints: 0
== micro_poseidon2_t3
non-linear constraints: 240
linear constraints: 0
== micro_poseidon_t5
non-linear constraints: 297
linear constraints: 0
== micro_poseidon2_t4
non-linear constraints: 264
linear constraints: 0
== transfer
non-linear constraints: 6384
linear constraints: 0
== transfer_p2_merkle
non-linear constraints: 6384
linear constraints: 0
== transfer_p2_all
non-linear constraints: 6276
linear constraints: 0
```

Proving output (raw):

```
setup transfer: 10.1 s, zkey 6001417 bytes
setup transfer_p2_all: 8.3 s, zkey 5823881 bytes
verify transfer: true
verify transfer_p2_all: true

=== fullProve (witness + prove), 15 interleaved runs, --O1, node v22.23.4 ===
transfer           mean 816.2 ms  sd 31.5  min 757.0  zkey 6001417 B
transfer_p2_all    mean 756.8 ms  sd 43.7  min 666.2  zkey 5823881 B
ratio p2_all/baseline (mean): 0.927
```

Reproduce: `CIRCOM=<circom2> bash scripts/bench/poseidon2/constraints.sh <out>`; then
`node scripts/bench/poseidon2/equivalence.mjs <out> O1` and
`node scripts/bench/poseidon2/prove-compare.mjs <out> <pot15.ptau> --runs 15`
(needs `cd circuits && npm ci`, and `node_modules` resolvable from `scripts/bench`).

**Why it lost.** In R1CS the linear layers are free, and a degree-5 S-box costs 3 constraints in
both designs, so Poseidon2's headline savings (cheap linear layers) do not apply: Poseidon2 t=3 is
240 non-linear constraints vs Poseidon's 240 after linear optimisation. The only gain is the t=4 vs
t=5 shape for 3-input hashes (264 vs 297–300), worth ~130 constraints in transfer. The structural
finding: **the 20-level Merkle path is 20×240 = 4,800 of 6,384 (75%) of transfer's non-linear
constraints** — hash choice cannot move that; depth or arity can.

Not run: the full suite (`npm test` in `circuits/`, Move tests). No production circuit, Move module
or frontend code changed, and there is no `CLAUDE.md` in the repo; the production build artifacts
were not regenerated. This is a skipped verification, not a pass.

## Verdict

**REJECT** — hypothesis falsified (-3.0% non-linear vs ≥10% required). Branch kept. Additional costs
that make a swap unattractive even at -3.7%: new ceremony, full tree/commitment migration, frontend
`circomlibjs` replacement, younger primitive, no Sui-native Poseidon2 (the Move side does not hash
Poseidon today, so that last point is only a constraint on any future on-chain tree update).

## Where this could be used

Negative result worth citing in a thesis chapter on hash choice for R1CS vs Plonkish: Poseidon2's
gains are an arithmetisation property, so it matters for Halo2/Plonky3-style protocols (e.g. a
future Veil port per queue item 9) but not for Groth16 pools like Veil. Applicable to any
Circom/Groth16 payment or membership protocol (Tornado-style pools, Semaphore-style group
membership on Sui) deciding whether to migrate hashes: measure, don't assume.

## Open questions → queue

1. Merkle **arity-4** (depth 10, Poseidon t=5 ≈ 300 non-linear per level ⇒ ≈3,000 vs 4,800 — a
   *prediction*, UNMEASURED) vs depth-20 binary: constraint, proving-time and client-side tree-update cost.
2. Does a shallower tree (depth 16/18) at the same anonymity-set need pay off — and what is Veil's real
   leaf count? (links to queue item 4/RR5.)
3. Poseidon2 inside a Halo2/Plonk-ish port — the case where it should win (item 9).
4. Gas still unmeasured — needs approved network access or a bundled `sui` binary.

## Gas attempt (queue item #1) — BLOCKED

Both unblock paths from the queue were tried at the start of the run and are denied by the sandbox
egress policy (do not retry): `POST https://fullnode.testnet.sui.io:443` → `curl: (56) CONNECT tunnel
failed, response 403`; `https://github.com/MystenLabs/sui/releases/latest` → `HTTP/1.1 403 Forbidden`.
Building Sui from source is not budgetable in one run. Missing: an allowlisted route to a Sui fullnode
RPC (read-only `suix_queryTransactionBlocks` against the README package ID) **or** a prebuilt `sui`
binary. No gas number is claimed anywhere.
