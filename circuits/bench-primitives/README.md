# Primitive constraint benchmarks

Isolated, single-component circuits used to attribute exactly how many R1CS constraints each
gadget in `transfer.circom` / `compliance.circom` / `withdraw.circom` costs on its own. None of
these are part of the protocol — they exist only to measure `circomlib` template output with
`snarkjs r1cs info`, so a whole-circuit constraint count can be reconstructed as a sum of named
parts instead of a single opaque number.

Reproduce: `bash ../scripts/bench-primitives.sh` (from this directory, or see that script).

See `docs/research/2026-09-22-poseidon-constraint-attribution.md` for the results and what they're
used for.
