# 2026-10-19 — Poseidon2 vs Poseidon in R1CS, and a 4-ary Merkle tree (queue item #2)

Queue item #1 (on-chain gas) was attempted first and is **BLOCKED for the third time** — see
"Gas attempt" at the end. Tonight's measured experiment is therefore item #2.

## Hypothesis

Replacing circomlib's Poseidon with Poseidon2 (BN254, x⁵) cuts `transfer.circom`'s R1CS constraint
count by ≥10 % (baseline 13,611) and Node proving time by a similar amount. **Prediction made before
measuring: false** — in R1CS the linear layers are free, so Poseidon2's cheaper matrices should not
help; only S-box count matters. The experiment also tests the alternative lever the numbers pointed
at: the depth-20 binary Merkle path is 10,400 of 13,611 constraints (76 %), so an arity-4 depth-10
tree (same 2²⁰ capacity) should cut the circuit by ~20 %.

## Threat / privacy model

- **Adversary:** chain observer / statistical deanonymiser. Sees public inputs
  (`oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot`), the proof,
  and the pool's `commitment_root`. A malicious prover tries to prove membership of a leaf that is not in
  the tree, or to double-spend by forging a path.
- **Leakage of the arity-4 variant:** none new. The path (`slots`, `bits`) is private; public inputs are
  identical (7), so the proof, vk size (4,029 → 4,024 B) and on-chain interface are unchanged. The
  anonymity set is the same (4¹⁰ = 2²⁰ leaves). Path position bits stay private, as before.
- **Soundness argument (arity-4 template, `scripts/bench/arity4-transfer.mjs`):** per level the prover
  supplies all four slots and two bits `b0,b1` (both constrained boolean). One-hot indicators
  `ind_j` are derived algebraically from the bits (exactly one is 1). The circuit enforces
  `Σ ind_j·slot_j == node`, i.e. the running node occupies the slot named by the bits, and then hashes all
  four slots with Poseidon(4). Siblings are free witness values exactly as in the binary tree, so no
  freedom is gained: a different slot order yields a different parent hash, which must still chain to the
  public root. Collision resistance of Poseidon(4) therefore gives membership soundness.
- **Does NOT defend against / residual surface:** unchanged — RR2 (single-contributor dev setup),
  RR5 (deposit linkability), RR3 (sybil). Poseidon(4) here is *un-domain-tagged* for tree nodes, same as the
  existing binary tree's Poseidon(2); a leaf/internal-node confusion (second-preimage across levels) is
  prevented only by fixed depth, as today. Not addressed tonight.
- **Poseidon2 parameters:** the comparison circuit uses **placeholder constants** (SHA-256-derived), not the
  audited HorizenLabs set. Constraint counts are independent of constant values; the circuit is
  **not** a usable Poseidon2 and must not be deployed. No security claim is made about it.
- **Assumptions:** BN254/Groth16 as before; Poseidon security for t=5 (arity-4) is the circomlib
  instance already used by the commitment hash. STRIDE: Tampering (forged membership) and Information
  Disclosure entries in `docs/threat-model.md`; no row changes.

## Approach

Built, all under `scripts/bench/` (no protocol file modified):

- `poseidon-constraints.mjs` — compiles micro-circuits and prints constraint counts: circomlib
  Poseidon(2..5), structural Poseidon2 t=3/4/8, a depth-20 binary Merkle path with each, and the arity-4
  depth-10 path.
- `arity4-transfer.mjs` — generates a real variant of `circuits/transfer.circom` (text-substituted so it
  tracks the repo file) with the arity-4 path, does Groth16 setup for both variants against the *same*
  locally generated dev ptau, proves **interleaved** base/variant (20 runs each), verifies proofs, and runs
  five malicious-witness negative tests.

Rejected before building: (a) wiring Poseidon2 into the live circuit/Move/SDK — the structural count
already decides it; (b) a one-hot *sibling-ordering* constraint for the 4-ary tree — unnecessary, siblings
are free (see soundness argument) and it would cost more; (c) `Mux2`-based selection — more constraints
than the indicator trick.

## Results

Env: circom 2.2.3 (npm `circom2`, WASM build), snarkjs 0.7.6, Node v22.22.0, local dev ptau (2¹⁵). The
baseline circuit reproduces `BASELINE.md` exactly (13,611 / 6,470 non-linear).

### Primitive and Merkle-path constraints (`node scripts/bench/poseidon-constraints.mjs --circom <circom2>`)

| Component | Total constraints | Non-linear |
|---|---|---|
| circomlib Poseidon(2) | 517 | 243 |
| circomlib Poseidon(3) | 605 | 264 |
| circomlib Poseidon(4) | 736 | 300 |
| circomlib Poseidon(5) | 835 | 324 |
| Poseidon2 t=3 (2→1) | 515 | 240 |
| Poseidon2 t=4 | 612 | 264 |
| Poseidon2 t=8 | 1,012 | 363 |
| Merkle depth 20, binary, circomlib | 10,400 | 4,920 |
| Merkle depth 20, binary, Poseidon2 t=3 | 10,360 | 4,860 |
| Merkle depth 10, **4-ary**, circomlib Poseidon(4) | **7,470** | **3,070** |

```
name	total_constraints	non_linear
circomlib_Poseidon2	517	243
circomlib_Poseidon3	605	264
circomlib_Poseidon4	736	300
circomlib_Poseidon5	835	324
poseidon2_t3	515	240
poseidon2_t4	612	264
poseidon2_t8	1012	363
merkle20_circomlib	10400	4920
merkle20_poseidon2_t3	10360	4860
merkle4x10_circomlib_Poseidon4	7470	3070
```

### Full transfer circuit, base vs 4-ary (`node scripts/bench/arity4-transfer.mjs --circom <circom2> --runs 20`)

| | Base (binary, depth 20) | 4-ary, depth 10 | Δ |
|---|---|---|---|
| R1CS constraints | 13,611 | 10,681 | **−21.5 %** |
| Non-linear | 6,470 | 4,620 | −28.6 % |
| zkey bytes | 6,001,419 | 4,902,459 | −18.3 % |
| Node prove mean (20 runs, interleaved) | 1,167.8 ms (σ 71.5) | 1,032.2 ms (σ 76.4) | **−11.6 %** |
| Node prove min | 1,069.9 ms | 905.6 ms | −15.4 % |
| Proof verifies | true | true | — |

Raw output (negative tests included; five malicious witnesses, all rejected):

```
"base":   { "constraints": 13611, "nonLinear": 6470, "linear": 7141, "zkeyBytes": 6001419, "verifies": true, "meanMs": 1167.8, "sdMs": 71.5, "minMs": 1069.9 }
"arity4": { "constraints": 10681, "nonLinear": 4620, "linear": 6061, "zkeyBytes": 4902459, "verifies": true, "meanMs": 1032.2, "sdMs": 76.4, "minMs": 905.6 }
N1 wrong position bit at level 3 (node not at claimed slot)      rejected: Assert Failed, MerkleProof4 line 21
N2 non-boolean position bit (2)                                   rejected: Assert Failed, MerkleProof4 line 13
N3 sibling tampered, root unchanged                               rejected: Assert Failed, MerkleProof4 line 21
N4 leaf not in tree (oldCommitment replaced)                      rejected: Assert Failed, MerkleProof4 line 21
N5 node moved from slot 3 to slot 2 at level 7, bits still (1,1) rejected: Assert Failed, MerkleProof4 line 21
```

Caveats, stated plainly: (1) absolute proving times are ~1.5× slower than the 2026-07-22 baseline
(752 ms) — a different, noisier container; only the within-run ratio is meaningful, and `BASELINE.md`
timings are **not** updated. (2) Proving time fell 11.6 %, about half the constraint reduction — fixed costs
(witness generation, FFT padding to the next power of two: 13,611 and 10,681 both fall in 2¹⁴ = 16,384) mean
the domain size did **not** shrink; the saving is MSM-size only. Getting under 8,192 constraints would
unlock a full FFT-size halving. (3) The Poseidon2 circuit is structural-only (see above). (4) An earlier
run of the script had a bug in my N5 test (mutation was a no-op → "not rejected"); fixed and rerun —
the table above is the corrected run.

## Verdict

- **Poseidon2 in Groth16/R1CS: REJECT.** −40 constraints on a 10,400-constraint path (−0.4 %),
  −2 on a single hash; t=8 (needed for Veil's 4-input hashes, which have no standard Poseidon2 width) is
  *worse* than circomlib's t=5 (363 vs 300 non-linear). Poseidon2's advantage is in native / Plonkish
  settings, not R1CS. Branch kept.
- **4-ary depth-10 Merkle path: PARK.** Real, measured, sound-by-argument, negative-tested: −21.5 %
  constraints, −11.6 % proving time. Not merged: it changes the tree format (indexer/tree builder, frontend
  path assembly, `circuits/test`), requires a new vk and a re-based `commitment_root` (pre-mainnet only), and
  I did not port the repo's test suite to it. Blocked on that integration + the 2¹³ question below.
- Overall ledger verdict: **REJECT** (stated hypothesis), with a PARK follow-up queued.
- `BASELINE.md`, `threat-model.md`, `SPEC.md`: unchanged (nothing KEEP).
- Repo test suite: **not run** — no file under `circuits/`, `contracts/`, `frontend/` changed; the
  circuit tests need the compiled build artifacts and no `sui` CLI exists for Move tests.

## Where this could be used

Any Circom/Groth16 membership-proof system with a large anonymity set: Tornado-style pools, Semaphore-class
group-membership/voting (Semaphore's tree is binary Poseidon(2)); confidential payroll on Sui with a
t-of-n auditor board where the dominant per-payslip proof cost is the depth-20 path; thesis chapter on
"constraint-aware accumulator design": R1CS rewards wide, shallow trees (Poseidon cost grows ~linearly in
width, path cost in depth) while Plonkish systems reward the opposite trade-off.

## Open questions (tomorrow's queue)

1. Can the transfer circuit get under 2¹³ = 8,192 constraints? 4-ary tree + Num2Bits reduction (the 64-bit
   range checks — their share is unmeasured) + arity-8 tree (depth 7, Poseidon(8)) — measure arity 8.
2. Integrate arity-4 properly: tree builder/indexer, test suite port, new `circuits/test` negatives, vk.
3. Domain-separate tree-node hashes from leaf hashes (leaf/node confusion).
4. Real Poseidon2 for a Plonk/Halo2 port (queue #9) — structural count says it only pays there.
5. Gas, a third time — see below.

## Gas attempt (queue #1) — BLOCKED, third time

`curl https://github.com/MystenLabs/sui/releases/latest` → HTTP 403 and
`POST https://fullnode.testnet.sui.io:443` → CONNECT 403; the proxy status endpoint lists
`fullnode.testnet.sui.io:443 connect_rejected (policy denial)`. These are egress-policy denials, not
transient; not retried. `cargo install` from crates.io is not an option (no `sui` crate; git dependencies
sit behind the blocked GitHub host). **Unblock requires an environment-level change**: allow-list
`fullnode.testnet.sui.io` (read-only RPC) and/or `github.com/MystenLabs/sui/releases` in the routine's
network policy, or provide a pre-baked `sui` binary in the environment image.
