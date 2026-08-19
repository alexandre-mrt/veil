# Poseidon vs Poseidon2 arity benchmark

Research code for `docs/research/2026-08-19-poseidon2-arity-benchmark.md`. Not wired into any
Veil protocol circuit — nothing here is included by `transfer.circom`, `withdraw.circom`, or
`compliance.circom`.

- `vendor/` — `poseidon2.circom` + `poseidon2_constants.circom`, vendored verbatim from
  `@taceo/circom-lib` 0.6.0 (MIT, `vendor/LICENSE-taceo`). Supports state sizes t ∈ {2,3,4,8,12,16}.
- `hash.circom` — `Poseidon2Hash(nInputs)` / `Poseidon2HashPadded(nInputs, tFixed)`, thin wrappers
  matching circomlib's `Poseidon(nInputs)` convention (capacity=0, output=permuted `state[0]`).
- `bench/` — eight standalone `main` circuits (circomlib `Poseidon` and the Poseidon2 equivalents,
  at Veil's actual call arities: 2, 3, 4, 5 inputs). Build with
  `bash scripts/bench/poseidon2-bench-setup.sh` from the repo root; time with
  `node scripts/bench/poseidon2-prove-latency.mjs`.
- `verify/` — correctness cross-checks (`verify.mjs`, against two independent Poseidon2
  implementations) and a negative test (`negative_test.cjs`, tampered-witness rejection). Run
  `npm install && node verify.mjs && node negative_test.cjs` from this directory (after the bench
  circuits are built).

See the report for why this exists, the full results, and the verdict (REJECT, for now).
