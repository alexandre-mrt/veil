# Poseidon2 vs Poseidon — and where Veil's constraints actually go

Date: 2026-10-29 · Branch: `research/2026-10-29-poseidon2-vs-merkle-arity`
Status: **UNMEASURED (design-only, analytic model) — verdict PARK**. Nothing below the
"Predictions" heading was compiled or proved; every such number is labelled UNMEASURED.

## What happened tonight

Queue item #1 (on-chain gas) was attempted first and is **BLOCKED for a third time**, now with a
precise cause. A prebuilt `sui` binary *is* reachable (`github.com/MystenLabs/sui/releases/download/
testnet-v1.60.0/sui-testnet-v1.60.0-ubuntu-x86_64.tgz`, 837 MB, downloaded and listed fine), but the
sandbox's permission layer refused to **execute** it ("Code from External"). `fullnode.testnet.sui.io`
is refused by the egress proxy (HTTP 403 on CONNECT), so the JSON-RPC route is closed too.

Queue item #2 (Poseidon2) needs `circom`. The prebuilt route does not exist for circom 2.2.2 here and
`cargo build --release` of a cloned `iden3/circom` was refused by the same layer. No further
workaround was attempted (an npm WASM build of circom would be the same intent by another route).
So no circuit could be compiled tonight. Per the loop's rules this note is a design-only
experiment, and it does one thing that needs no compiler: it reverse-engineers the constraint model
and checks it against the numbers already measured in `BASELINE.md`.

## Hypothesis

Replacing circomlib Poseidon with Poseidon2 reduces `transfer.circom`'s proving time by a visible
margin (the queue assumed "four Poseidon instances dominate"). **Predicted falsified**: Poseidon2
reduces `transfer`'s non-linear constraints by only ~3.0 % (≈ 22 ms of 752 ms, inside the σ = 17 ms
run-to-run noise), whereas a 4-ary Merkle tree of the same 2^20 capacity is predicted to cut ~27–28 %.

## Threat / privacy model

No adversary model changes; this is a cost analysis. Relevant adversaries if either change were
later built: *chain observer* — learns the Merkle root and nullifier as today; arity does not
change what is public. *Malicious prover* — soundness must be re-argued for any new hash (Poseidon2
has far less cryptanalysis than Poseidon, the main non-numeric cost of that swap) and for a 4-ary
selector (the two path-index bits must be constrained boolean; a non-boolean index lets the prover
choose arbitrary child ordering — needs a negative test). Residual surface unchanged: single-
contributor dev setup (RR2), deposit linkability (RR5, only anonymity-set size helps — arity does
not change the 2^20 capacity). Assumptions: Groth16/BN254, trusted setup. STRIDE: none directly;
touches Tampering (circuit soundness) if built.

## Approach

Rather than guess, derive the exact cost formula from `circomlib/circuits/poseidon.circom` and
Veil's templates, then **validate it against measured data before trusting it for predictions**:

- `Sigma` (x^5) = 3 multiplications; `Poseidon(n)`: t=n+1, 8 full rounds, `N_ROUNDS_P[t-2]` partial
  rounds, linear layers free ⇒ non-linear = 3·(8t + R_P).
- Merkle level = boolean check (1) + `MultiMux1(2)` (2) + `Poseidon(2)` (243) = 246.
- `Num2Bits(n)` = n; comparators over n bits = n+1.

Script: `scripts/bench/constraint-model.mjs` (reads the round table from the installed circomlib).

Rejected before writing: building a throw-away Poseidon2 circuit with placeholder constants —
constraint counts would be right but it would invite being mistaken for a hash; and using a WASM
circom from npm to dodge the sandbox refusal.

## Results

### Validation: model vs measured (the only measured content here)

Command: `node scripts/bench/constraint-model.mjs`

```
== validation: model vs measured non-linear constraints (BASELINE.md) ==
withdraw    model 1465 measured 1465 EXACT
transfer    model 6470 measured 6470 EXACT
compliance  model 6057 measured 6057 EXACT

== per-instance Poseidon cost (non-linear constraints) ==
Poseidon(2) t=3: 243
Poseidon(3) t=4: 264
Poseidon(4) t=5: 300
Poseidon(5) t=6: 324
Merkle level (bool + mux + Poseidon(2)): 246
Merkle path depth 20: 4920 = 76.0% of transfer non-linear
```

The "measured" column is from the 2026-07-22 `snarkjs r1cs info` run, not re-measured tonight. An
exact match on three structurally different circuits is strong evidence the formula is right; it is
not a re-measurement.

**Correction to the queue:** `transfer` contains 24 Poseidon instances, not four — 20 are the Merkle
path. 76 % of its non-linear constraints are the depth-20 path.

### Predictions — UNMEASURED

```
== UNMEASURED prediction A: Poseidon2 swap (domain tag in capacity slot) ==
withdraw    1465 -> 1354 (-7.6%)
transfer    6470 -> 6278 (-3.0%)
compliance  6057 -> 5988 (-1.1%)

== UNMEASURED prediction B: 4-ary Merkle tree, depth 10 (same 2^20 leaves) ==
select cost  8/level: level=308  path=3080  transfer 6470->4630 (-28.4%)  compliance 6057->4217 (-30.4%)
select cost 14/level: level=314  path=3140  transfer 6470->4690 (-27.5%)  compliance 6057->4277 (-29.4%)
select cost 20/level: level=320  path=3200  transfer 6470->4750 (-26.6%)  compliance 6057->4337 (-28.4%)
```

Caveats, stated bluntly: Poseidon2 t=3 (R_F=8, R_P=56, d=5) was verified in
`HorizenLabs/poseidon2@055bde3` (`poseidon2_instance_bn256.rs`); t=4 R_P=56 and t=8 R_P=57 are the
paper's values, **not verified here** (that repo ships only t=3). Poseidon2 has no t=5/t=6 instance, so
compliance's 5-input leaf falls to t=8. The 4-ary selector cost (8–20/level) is an assumption and is
swept; the conclusion (~27–30 %) is insensitive to it. Prover time is assumed ∝ constraints
(it is dominated by MSMs/FFT over the 13,611 total, of which 7,141 are linear and shrink less).

## Verdict: **PARK**

Poseidon2 is not worth a migration for R1CS (≤ 3 % on `transfer`). The promising result is the
Merkle arity change, but it is unbuilt. Blocked on: a working `circom` (or a permitted way to build
it). Notably it needs **no Move change** — the pool stores only the 32-byte root and the admin/
indexer computes it off-chain (`pool.move:77`, `update_commitment_root`) — only circuits, indexer
and client tree code.

## Where this could be used

- Any Circom/Groth16 membership-proof protocol (Tornado-style pools, Semaphore groups, confidential
  payroll on Sui with a t-of-n auditor board): the model says tree arity, not hash choice, is the
  lever when the path dominates. Thesis chapter: "constraint accounting for ZK payment circuits".
- The validated model lets later nights size a change before compiling anything.

## Open questions (tomorrow's queue)

1. Build the 4-ary tree (new #1 if a compiler is available): measure constraints, proving time, add
   boolean-index negative test, soundness + leakage note.
2. Unblock tooling: the operator must allow executing a prebuilt `sui` (v1.60.0 tarball confirmed
   downloadable) and building/obtaining `circom` 2.2.2, or a pre-baked environment image.
3. Verify Poseidon2 t=4/t=8 round numbers (needs the Sage script run).
4. Gas per entry point (still unmeasured).
