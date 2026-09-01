# Poseidon2 constraint-delta experiment (EXPERIMENTAL — not production code)

Full writeup: [`docs/research/2026-09-01-poseidon2-constraint-delta.md`](../../docs/research/2026-09-01-poseidon2-constraint-delta.md).

This directory holds mechanically-derived copies of `../transfer.circom`,
`../compliance.circom`, and `../withdraw.circom` with every `Poseidon(n)` call
swapped for `Poseidon2Hash(n)` (built on `@taceo/circom-lib`'s `Poseidon2(t)`
permutation) and `MerkleProof` swapped for `MerkleProofP2`. **None of this is
wired into the app, the Move contracts, or any deployed verification key.** It
exists purely to produce real, compiled, measured constraint-count and
proving-time numbers for the writeup above — not as a proposed migration.

## Why this isn't a drop-in swap

`@taceo/circom-lib@0.9.0`'s `Poseidon2(t)` only ships round constants for
`t ∈ {2, 3, 4, 8, 12, 16}`. Veil's circuits call `Poseidon(nInputs)` at
`nInputs ∈ {2, 3, 4, 5}` (state size `t = nInputs + 1 ∈ {3, 4, 5, 6}`). `t=5`
and `t=6` have no native Poseidon2 parameters, so `poseidon2_hash.circom`
zero-pads up to the next supported width (`t=8`) for those. That padding is
naive — it does not encode input arity into the padded slots — and is only
safe here because every call site uses a fixed, compile-time-constant
`nInputs`. See the file's own header comment and the writeup's Verdict section
for what a production-safe version would need.

## Reproduce

```bash
cd circuits/poseidon2-experiment
bash compile-p2.sh                                    # circom + Groth16 setup, all 3 variants
node negative-test.mjs                                 # soundness check (real Groth16 proofs)
node ../../scripts/bench/poseidon2-prove-latency.mjs --runs 10
```

Requires circom 2.2.2+ on `PATH` — see the writeup's Approach section for how
it was built for this experiment (same `cargo build --release` against
`iden3/circom` tag `v2.2.2` as the 2026-07-22 baseline).

`build/` (r1cs, wasm, zkey, ptau) and `node_modules/` are gitignored — nothing
here is a build artifact you should expect to find already present in a fresh
checkout.
