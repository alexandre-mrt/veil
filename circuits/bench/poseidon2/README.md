# Poseidon vs Poseidon2 constraint-count bench

Research artifact for `docs/research/2026-09-13-poseidon2-arity-gap.md` (queue item #2, verdict
**REJECT**). Not wired into any production circuit — kept fully separate from `transfer.circom`,
`compliance.circom`, and `withdraw.circom`.

## What's here

- `poseidon2_hash.circom` — `Poseidon2Hash(nInputs)`, a fixed-input-length hash built on
  `@taceo/circom-lib`'s `Poseidon2(t)` permutation (an npm dependency of `circuits/`, pinned in
  `circuits/package.json` — nothing here is hand-copied). Mirrors circomlib's own
  `Poseidon(nInputs)` convention (capacity-first state, single-word squeeze) so the two are
  directly comparable at the same call site.
- `main_poseidon_t3.circom` / `main_poseidon2_t3.circom` — 2-input hash comparison (t=3), the
  arity `withdraw.circom`'s `recipientHash` uses.
- `main_poseidon_t4.circom` / `main_poseidon2_t4.circom` — 3-input hash comparison (t=4), the
  arity `transfer.circom`'s `txAmountHash` and `compliance.circom`'s `nfHash`/`ctxHash` use.
- `test/poseidon2.test.mjs` — correctness (against an independent JS reference,
  `@taceo/poseidon2`) and negative tests (a forged public `expectedHash` must be rejected).

Veil's other Poseidon call sites (`oldCommitment`/`newCommitment`/nullifiers at t=5,
`leafHash` at t=6 — 6 of Veil's 10 total Poseidon instances) are **not represented here**:
`@taceo/circom-lib` only ships published Poseidon2 parameters for t ∈ {2, 3, 4, 8, 12, 16}, the
widths the Poseidon2 paper itself gives concrete round constants for. See the report's "The arity
gap" section for the full breakdown and why deriving new parameters for t=5/t=6 wasn't attempted.

## Reproducing the numbers

```
bash scripts/bench/poseidon2-constraints.sh --runs 10
node --experimental-vm-modules circuits/bench/poseidon2/test/poseidon2.test.mjs
```

The first command compiles all four circuits (default optimization, then `--O2`), cross-checks
with `snarkjs r1cs info`, generates a local dev-only Powers of Tau (no network — see the report's
"Toolchain gaps" section for why), runs the dev-only Groth16 setup, and benchmarks proving time.

## Licensing

`@taceo/circom-lib` (MIT) and `@taceo/poseidon2` (MIT) are consumed as ordinary npm dependencies
of `circuits/` — see `circuits/package.json`. Nothing from either package is vendored/copied into
this directory.
