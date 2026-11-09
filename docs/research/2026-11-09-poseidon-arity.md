# 2026-11-09 — Poseidon2 vs arity-4 Merkle (UNMEASURED, design-only)

> **Status: BLOCKED → design-only fallback. Every constraint number below that is not in the
> "measured" column is UNMEASURED: it comes from an analytic model
> (`scripts/bench/constraint-model.mjs`), not from `circom --r1cs`.**

## Why this run did not measure anything

1. **Queue #1 (gas) still blocked.** `curl` to `github.com/.../releases` and to
   `fullnode.testnet.sui.io` both returned `403 CONNECT tunnel failed` from the egress proxy (policy
   denial; not retried). No `sui` CLI, no RPC.
2. **Queue #2 (this experiment) could not be measured either.** No `circom` binary is installed.
   `git ls-remote` against `iden3/circom` works, but the clone + `cargo build` of circom v2.2.2 was
   **denied by the session's auto-mode classifier** ("Code from External"). The 2026-07-22 run built
   it that way; this run was not allowed to. I did not try to route around the denial (e.g. an npm
   WASM build of circom) because it is the same intent. Needed to unblock: a prebuilt `circom` on the
   image, or explicit approval to build `iden3/circom` v2.2.2.

## Hypothesis

Replacing the depth-20 binary Poseidon Merkle path with an arity-4, depth-10 path (same 2^20 leaves)
cuts `transfer.circom` and `compliance.circom` non-linear constraints by ≥ 20 %; swapping Poseidon →
Poseidon2 at arity 2 changes them by < 2 %.

## Threat / privacy model

- **Adversary:** chain observer / statistical deanonymiser. Neither candidate changes what is
  public: the root, nullifier and proof stay the same shape. Anonymity set stays 2^20.
- **Not defended (unchanged residual surface):** deposit-commitment linkability (RR5), dev-only
  single-contributor setup (RR2), BN254 quantum exposure. Neither candidate touches them.
- **Assumptions:** Poseidon arity-4 (t=5) over BN254 is already used by Veil for commitments
  (`Poseidon(4)`), so no new primitive is introduced for candidate B. Candidate A *would* introduce a
  new primitive (Poseidon2), with less cryptanalysis history.
- **STRIDE:** Tampering/Spoofing of membership (T-entries on Merkle membership) — soundness argument
  for B would need: the 4-way selector is one-hot and the index decomposes to 2 bits per level
  (alias-free). **No circuit was changed tonight, so no soundness argument, leakage analysis or
  negative test was produced; they are required before B can be KEEP.**

## Approach

Read `circuits/templates/merkle_proof.circom` and circomlib's `poseidon.circom`. The R1CS cost is
dominated by x^5 S-boxes (3 multiplications each); linear layers and constant multiplications are
free. Model: `3·(8t + R_P − 1)` non-linear constraints per `Poseidon(t−1)`.

Rejected before building: porting to PLONK/Halo2 (queue #9, multi-night); swapping only the hash to
Poseidon2 without measuring (prediction below says it isn't worth the new primitive).

Notable fact (read from source, `grep` on `contracts/sources/*.move`): the Move contracts contain
**no on-chain Poseidon call** (only comments); the Merkle root is computed off-chain. So a Merkle
arity/hash change has **no on-chain gas impact** and does not need a Sui-native Poseidon2 — only
circuits, indexer and client tree code change.

## Results

Model output (`node scripts/bench/constraint-model.mjs`, raw):

```
per-instance non-linear constraints (model)
  circomlib Poseidon(2) : 240
  circomlib Poseidon(3) : 261
  circomlib Poseidon(4) : 297
  circomlib Poseidon(5) : 321
  Poseidon2 t=3          : 237

cross-check: modelled hash cost vs measured non-linear total
  transfer   hash model 5952  measured total 6470  residual (range checks, mux, misc) 518
  compliance hash model 5643  measured total 6057  residual (range checks, mux, misc) 414
  withdraw   hash model 1131  measured total 1465  residual (range checks, mux, misc) 334

Candidate A: Poseidon2 Merkle (depth 20, arity 2)
  now 4860  poseidon2 4800  delta -60

Candidate B: arity-4 Merkle, depth 10 (2^20 leaves)
  now 4860  arity-4 3090  delta -1770 (-36.4% of Merkle path)
  transfer: 6470 -> ~4700 non-linear (-27.4%)  [UNMEASURED]
  compliance: 6057 -> ~4287 non-linear (-29.2%)  [UNMEASURED]
```

| | Baseline (measured 2026-07-22) | Candidate A: Poseidon2 | Candidate B: arity-4 |
|---|---|---|---|
| transfer non-linear | 6,470 | ~6,410 (−0.9 %) UNMEASURED | ~4,700 (−27 %) UNMEASURED |
| compliance non-linear | 6,057 | ~5,997 (−1.0 %) UNMEASURED | ~4,287 (−29 %) UNMEASURED |
| prove time (Node) | 752 / 738 ms | — | — (not measured; roughly proportional to constraints, **unverified**) |

Model validity: the model only checks out loosely. The residuals (334–518) are plausible for
64-bit range checks + muxes but I could not decompose them without compiling. The 12-constraint
per-level 4-way selector in B is an **assumption** and the main uncertainty (±~500 constraints).
Poseidon2's R_P=56 is from memory of the paper's table, not verified.

## Verdict

**BLOCKED** (toolchain), design-only. Prediction, to be tested: A ≈ no gain (Poseidon2's win is
native/Plonk speed, not R1CS); B is the real lever (~−27 % non-linear constraints on both
Merkle-using circuits). Next: measure B.

## Where this could be used

Any Groth16 Merkle-membership circuit paying for depth: Tornado-style mixers, Semaphore-style
group membership on Sui, and the thesis chapter on "prover cost vs anonymity-set size" (arity as a
free knob when the root is hashed off-chain, as here).

## Open questions

- Does `circom` become available (prebuilt or approved build)? Without it, items 2–5 stay blocked.
- Real cost of the 4-way selector in circom (Quin selector / two-bit mux).
- Indexer/client tree code: how many places hard-code arity 2 / depth 20?
- Does arity-4 change the proof-of-membership leakage? (Expected no — index bits stay private.)
