# 2026-08-11 — Poseidon2 vs circomlib Poseidon: measured per-instance R1CS costs (queue item #2)

## Hypothesis

Veil's proving cost is dominated by Poseidon: the three production circuits contain 24, 23, and 4
Poseidon instances respectively (transfer, compliance, withdraw — counting the 20 hash levels
inside each `MerkleProof(20)`). If Poseidon2 — the 2023 successor design (Grassi–Khovratovich–
Schofnegger) with a cheaper linear layer — reduces per-instance R1CS cost, that saving multiplies
across every instance, every circuit, every transfer. Tonight tests: **does swapping circomlib
Poseidon for a real circom Poseidon2 implementation reduce Veil's constraint count and Groth16
proving time?**

Also settled here, because the same isolated-circuit rig answers it for free: the 2026-07-22
baseline's open question #4 — *exactly* how the 6,470 / 6,057 / 1,465 non-linear constraints of
the production circuits decompose per component, measured rather than inferred.

**Item #1 retry (on-chain gas), before pivoting here:** per the queue note, the first part of
tonight went to re-checking item #1's blockers. Result: still BLOCKED, with sharper edges than
before. (1) No `sui` binary on PATH. (2) JSON-RPC to `fullnode.testnet.sui.io:443` is a confirmed
**network-policy denial**, not a sandbox quirk — the egress proxy's status endpoint logs
`connect_rejected: gateway answered 403 to CONNECT` for that host. (3) New tonight: prebuilt
release binaries are unreachable — `https://github.com/MystenLabs/sui/releases/...` returns 403
through the proxy for *all* repos (even ones the session can `git clone`), so release-asset
download is policy-denied categorically. (4) Also new: `git ls-remote https://github.com/MystenLabs/sui.git`
**succeeds** — git-protocol access works, so a from-source build is no longer network-blocked,
only compute-blocked (full Sui workspace; the 2026-07-22 judgment that this exceeds one night's
budget still holds). The only remaining paths are a multi-night budgeted source build or an
egress-policy allowlist change for a Sui fullnode; noted in `EXPERIMENTS.md`.

## Threat / privacy model

**No production circuit, Move module, or frontend code was changed.** Every new `.circom` file
lives under `scripts/bench/poseidon2/` and exists purely to be measured; none is wired into any
build, deployment, or test that ships. There is no new attack surface, so the circuit-change
requirements (soundness argument for a shipped change, leakage analysis, negative test) do not
trigger. What follows is the soundness reasoning the experiment produced anyway, since the queue
item names "arity, domain-tag collisions" explicitly.

**Concrete adversary:** someone who can submit arbitrary proofs/public inputs on-chain and wants a
hash collision across Veil's Poseidon domains — e.g. forge a nullifier that equals a commitment,
or a Merkle inner node that equals a `recipientHash` — to double-spend (STRIDE S3) or bypass
binding (S2). They observe everything on-chain (commitments, nullifiers, roots, public inputs).

**Domain-tag audit across the three circuits** (tag = first Poseidon input; arity = circomlib
`Poseidon(k)`, which selects a *different* permutation per k, so cross-arity collisions would
require breaking Poseidon itself, not the tag scheme):

| Arity | Tags in use | Sites |
|---|---|---|
| Poseidon(4) | 1 (commitment, transfer+withdraw — intentionally shared, same object), 2 (transfer nullifier), 7 (withdraw nullifier) | pairwise distinct ✓ |
| Poseidon(3) | 3 (txAmountHash), 5 (compliance nullifier), 6 (contextId) | pairwise distinct ✓ |
| Poseidon(5) | 4 (credential leaf) | sole user ✓ |
| Poseidon(2) | 8 (recipientHash) **and untagged Merkle inner nodes** `H(left, right)` | see below |

The one same-arity overlap is Poseidon(2): a Merkle inner node with `left = 8` would equal
`recipientHash(recipient = right)`. This is not exploitable: every Poseidon(2) input inside a
Merkle path is either a commitment/credential leaf (itself a Poseidon output) or an inner-node
output, so forcing `left = 8` requires a Poseidon preimage of the constant 8 — preimage
resistance, not a tag-scheme gap. The existing fuzz property P5 ("domain separation no collision",
500 runs, passing tonight) covers the pairwise-tag side empirically. **Conclusion: the current
tag scheme is sound; nothing to fix.**

**Poseidon2-specific note** (had the swap won): the vendored sponge derives its capacity IV as
`2^64 + 256·t + rate` and uses `10*` padding, so hash width is itself domain-separating — but it
is *not* the SAFE padding the Poseidon2 paper recommends, and Veil's positional tags would have
had to be re-audited against sponge-block boundaries (a tag no longer necessarily sits in the same
permutation call as all data it separates, once inputs span multiple rate-2 blocks). Moot after
tonight's REJECT, but recorded for any future hash migration.

**What this does NOT defend against / assumptions:** unchanged from `docs/threat-model.md` —
Groth16 soundness under BN254 discrete log (S2), the dev-only trusted setup (RR2), deposit
linkability (I4). Mapping: supports S3 (nullifier uniqueness rests on domain separation, audited
above) and I2/I6 (commitments/nullifiers stay hiding — untouched); no entry's status changes.

## Approach

**What I built** (all under `scripts/bench/poseidon2/`, following the existing `scripts/bench/`
convention):

- `vendor/` — the only real circom Poseidon2 implementation found: **bkomuves/hash-circuits**
  (Faulhorn Labs, MIT, vendored with license; BN254, t=3, 8 external + 56 internal rounds,
  matching the Poseidon2 paper's parameters). Searched npm (`poseidon2`, `circom-poseidon2`,
  `poseidon2-circom`, `@zk-kit/poseidon2`, `@zk-kit/circuits`, `@taceo/poseidon2` — all either
  nonexistent or JS/TS-only, not circom) and GitHub (candidate repos other than bkomuves's do not
  exist).
- `circuits/` — 21 isolated single-component circuits: circomlib `Poseidon(2..5)` at exactly the
  arities production uses, the *production* `MerkleProof` template at depth 1 and 20, every
  range-check/comparator component the circuits instantiate, and Poseidon2 equivalents (bare
  permutation, 2-to-1 Merkle compression, sponge hashes of 3/4/5 elements at capacity 1 — the same
  ~128-bit level as circomlib — and capacity 2, upstream's default), plus `p2_merkle20.circom`: the
  production Merkle template with only the hash swapped to Poseidon2 compression.
- `constraint-costs.mjs` — compiles all 21 with the same circom 2.2.2 / default optimization as
  the production builds, prints one measured table.
- `merkle-prove-latency.mjs` — real Groth16 setup (same pot15 ptau as production) + verified proof
  + timed `fullProve` for the circomlib-vs-Poseidon2 depth-20 Merkle pair.

**Alternatives rejected:**
- *Swapping Poseidon2 into a full experimental transfer circuit* — pointless once the per-instance
  numbers came back negative (below); a full-circuit build could only interpolate between
  already-measured component costs.
- *Writing a Poseidon2 t=5/t=6 circom implementation from scratch* to hash arity 4/5 in one
  permutation — the round counts are published (t=4: 8 external + 56 internal ⇒ (32+56)×3 = 264
  non-linear, *identical* to circomlib Poseidon t=4), so hand-porting constants could not beat the
  status quo either; not worth a night.
- *Trusting the Poseidon2 paper's "same R1CS cost" remark without measuring* — the whole point of
  this loop is that the number comes from a command.

## Results

### Per-component R1CS cost (`node scripts/bench/poseidon2/constraint-costs.mjs`)

| Component | Non-linear constraints | Veil usage |
|---|---|---|
| circomlib `Poseidon(2)` (t=3) | **243** | Merkle levels, recipientHash |
| circomlib `Poseidon(3)` (t=4) | **264** | txAmountHash, compliance nullifier, contextId |
| circomlib `Poseidon(4)` (t=5) | **300** | commitments, transfer/withdraw nullifiers |
| circomlib `Poseidon(5)` (t=6) | **324** | credential leaf |
| Production Merkle level (bit check + mux + Poseidon(2)) | **246** | ×20 per Merkle proof |
| Production `MerkleProof(20)` | **4,920** | transfer, compliance |
| Poseidon2 permutation / 2-to-1 compression (t=3) | **240** | — |
| Poseidon2 Merkle level (bit check + mux + compression) | **243** | — |
| `p2_merkle20` (production structure, Poseidon2 hash) | **4,860** | — |
| Poseidon2 sponge hash, 3 inputs, capacity 1 | **480** (2 permutations) | vs 264 today → **+82%** |
| Poseidon2 sponge hash, 4 inputs, capacity 1 | **720** (3 permutations) | vs 300 today → **+140%** |
| Poseidon2 sponge hash, 5 inputs, capacity 1 | **720** (3 permutations) | vs 324 today → **+122%** |
| Poseidon2 sponge hash, 3 / 4 inputs, capacity 2 (upstream default) | **960 / 1,200** | vs 264 / 300 → +264% / +300% |
| `Num2Bits(64)` / `Num2Bits(8)` | 64 / 8 | range proofs |
| `GreaterThan(64)` / `LessEqThan(64)` / `GreaterEqThan(64)` / `GreaterEqThan(8)` | 65 / 65 / 65 / 9 | comparators |

Raw output:

```
$ node scripts/bench/poseidon2/constraint-costs.mjs
=== Per-component R1CS costs (circom 2.2.2, default optimization) ===

circuit                  total  non-linear  linear   wires
c_greatereqthan64           69          65      65      71
c_greatereqthan8            13           9       9      15
c_greaterthan64             68          65      65      70
c_lesseqthan64              69          65      65      71
c_merkle1                  520         246     246     523
c_merkle20               10400        4920    4920   10422
c_num2bits64                65          64      64      66
c_num2bits8                  9           8       8      10
c_poseidon2                517         243     243     520
c_poseidon3                605         264     264     609
c_poseidon4                736         300     300     741
c_poseidon5                835         324     324     841
p2_compression             515         240     240     518
p2_hash3_c1               1034         480     480    1038
p2_hash3_c2               2064         960     960    2068
p2_hash4_c1               1551         720     720    1556
p2_hash4_c2               2580        1200    1200    2585
p2_hash5_c1               1551         720     720    1557
p2_merkle20              10360        4860    4860   10382
p2_perm                    515         240     240     519
```

### Exact attribution of the production baselines (every 2026-07-22 number reconciled)

| Circuit (baseline non-linear) | Poseidon-related | Range/comparator | Other | Sum | Poseidon share |
|---|---|---|---|---|---|
| transfer (6,470) | MerkleProof(20) 4,920 + 3×Poseidon(4) 900 + Poseidon(3) 264 = 6,084 | 4×Num2Bits(64) 256 + GreaterThan(64) 65 + LessEqThan(64) 65 = 386 | 0 | **6,470** ✓ | **94.0%** (6,084/6,470) |
| compliance (6,057) | MerkleProof(20) 4,920 + Poseidon(5) 324 + 2×Poseidon(3) 528 = 5,772 | 3×Num2Bits(64) 192 + 2×Num2Bits(8) 16 + GreaterEqThan(64) 65 + GreaterEqThan(8) 9 = 282 | 2 binary-enforcement + 1 AND product = 3 | **6,057** ✓ | **95.3%** |
| withdraw (1,465) | 3×Poseidon(4) 900 + Poseidon(2) 243 = 1,143 | 3×Num2Bits(64) 192 + GreaterThan(64) 65 + LessEqThan(64) 65 = 322 | 0 | **1,465** ✓ | **78.0%** |

Every production circuit's non-linear count decomposes to the constraint with zero residual —
Poseidon is 94–95% of the two big circuits, and the depth-20 Merkle proof alone is 76% / 81% of
transfer / compliance. (Baseline totals re-verified tonight on a fresh compile: raw output below.)

```
$ circom transfer.circom --r1cs -l node_modules   # (same for withdraw, compliance)
transfer:   non-linear constraints: 6470   linear constraints: 7141   wires: 13632
withdraw:   non-linear constraints: 1465   linear constraints: 1593   wires: 3058
compliance: non-linear constraints: 6057   linear constraints: 6686   wires: 12762

$ npx snarkjs r1cs info build/transfer.r1cs          → # of Constraints: 13611
$ npx snarkjs r1cs info build-withdraw/withdraw.r1cs → # of Constraints: 3058
$ npx snarkjs r1cs info build-compliance/compliance.r1cs → # of Constraints: 12743
```

### Head-to-head Groth16 proving (`node scripts/bench/poseidon2/merkle-prove-latency.mjs --runs 10`)

| Depth-20 Merkle proof | Non-linear | Linear | Proving time (mean of 10, witness gen included) |
|---|---|---|---|
| circomlib Poseidon (production template) | 4,920 | 5,480 | **769.30 ms** (σ 10.93) |
| Poseidon2 t=3 compression (same structure) | 4,860 (−1.2%) | 5,500 (+0.4%) | **789.82 ms** (σ 6.95) — **+2.7% slower** |

```
=== Depth-20 Merkle proof: circomlib Poseidon vs Poseidon2 (t=3) — 10 runs each ===
node v22.22.2, linux/x64

--- c_merkle20 ---
  runs: 10
  mean: 769.30 ms   stddev: 10.93 ms   min: 752.18 ms   max: 788.04 ms
--- p2_merkle20 ---
  runs: 10
  mean: 789.82 ms   stddev: 6.95 ms   min: 783.58 ms   max: 807.47 ms

Poseidon2 / Poseidon mean ratio: 1.027x
```

Both proofs verified against their real Groth16 setup (same pot15 ptau as production) before
timing. The 60-constraint saving is invisible to the prover; the extra witness-computation work in
the Poseidon2 linear layers (18,484 labels vs 15,544) actually costs more than it saves in snarkjs.

### Whole-circuit extrapolation (from measured component costs — no full swap was built)

- Merkle-only swap in transfer: −60 of 13,611 total constraints = **−0.4%**, and measured proving
  time goes the wrong way.
- Full swap (Merkle + all sponge hashes, capacity 1): transfer −60 + (3×420) + 216 = **+1,416
  non-linear (+22%)**. Strictly worse everywhere.

### Test suite (full run tonight; nothing loosened or skipped)

| Suite | Result | Command |
|---|---|---|
| Circuits (real Groth16) | **108/108** (43 transfer + 30 compliance + 35 withdraw) | `cd circuits && npm test` (chained run now completes — the 2026-07-22 hang was fixed by #17) |
| Proof converter | **109/109** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils | **67/67** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Frontend (vitest) | **19/19** | `cd frontend && bunx vitest run` |
| Property fuzz | **6/6 properties** (500 runs each, incl. P5 domain separation) | `cd scripts && bun run src/fuzz-tests.ts` |
| Move contracts (124 tests) | **NOT RUN — pre-existing env gap** | `sui` CLI unavailable in this environment (`which sui` → nothing); same blocker as 2026-07-22, unrelated to tonight's change (no Move code touched) |

## Verdict: **REJECT**

Poseidon2 does not help Veil under Groth16/R1CS, and this is now measured, not assumed:

- **Merkle path (the 76–81% dominant cost): −1.2% constraints, +2.7% measured proving time.** Net loss.
- **Every wide hash Veil uses (arity 3/4/5): +82% to +140% constraints** via the only available
  circom implementation (t=3 sponge), because arity > 2 forces multiple permutations. Even a
  hypothetical native t=4 Poseidon2 port would land at 264 non-linear — *exactly* circomlib's cost,
  by the published round counts.

Poseidon2's real advantages (cheaper matrix multiplication in native provers, Plonkish/AIR
arithmetizations, hash-chain throughput) do not translate to R1CS S-box counting, which is the
only thing Groth16 pays for. The right levers for Veil's constraint count are *fewer hash calls*
(Merkle depth/arity trade-offs, item #4) or a *different hash design* (e.g. Griffin claims ~2×
fewer R1CS constraints per permutation and has a circom implementation in the same vendored repo)
— not Poseidon→Poseidon2. If Veil ever migrates proof systems (queue item #9), re-open this: under
Plonkish arithmetization the answer likely flips.

Nothing in `BASELINE.md` changes (verdict is REJECT; production numbers were reproduced exactly).

## Where this could be used beyond Veil

- **Any Groth16/R1CS protocol weighing a Poseidon2 migration** — Semaphore-style membership
  protocols, Tornado-class mixers, circomlib-based rollup circuits: the per-instance table here
  (243/264/300/324 vs 240 + sponge blow-up) is the whole decision, and it says *don't*, unless and
  until you leave R1CS. The result generalizes because it's a property of the two designs' S-box
  counts, not of Veil.
- **A thesis chapter on arithmetization-dependence of hash choice**: Poseidon2 is a strict win in
  native speed and Plonkish cost yet a strict loss in R1CS sponge mode at t=3 — a clean worked
  example that "faster hash" is not a well-formed claim without naming the cost model.
- **Deployment guidance for Merkle-heavy circuits on BN254** (credential registries, airdrop
  claims, nullifier sets): the exact attribution method here (isolated single-component circuits,
  zero-residual reconciliation against the full circuit) is reusable as-is via
  `scripts/bench/poseidon2/constraint-costs.mjs`.

## Open questions (for the queue)

1. **Griffin instead of Poseidon2** — same vendored repo ships a Griffin t=3 permutation for
   BN254; the design targets low R1CS degree and could plausibly beat 243/level on the Merkle
   path, which is 76–81% of Veil's big circuits. Measure before believing; cryptanalysis maturity
   of Griffin is a real concern to weigh in any KEEP.
2. **Merkle arity trade-off, now precisely computable** — a depth-10 arity-4 tree needs 10×
   Poseidon(4) = 3,000 non-linear vs today's 4,860+mux for the same 2^20 anonymity set (plus wider
   muxes); worth measuring as part of item #4 (accumulator at scale).
3. **Item #1 (gas) unblock paths, updated**: git-protocol access to MystenLabs/sui *works* from
   this environment — a from-source `sui` build split across nights (or a cached binary artifact
   committed to CI) is now the credible route; RPC and release-binary downloads remain
   policy-denied.
4. If a future night ports any new hash in, the sponge-padding domain-separation interaction with
   Veil's positional tags (Threat model section above) must be re-audited — recorded here so it
   doesn't get lost.
