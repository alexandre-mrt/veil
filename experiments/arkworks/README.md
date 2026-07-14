# Arkworks Prover-Parity Spike

Reimplements `circuits/transfer.circom` (Veil transfer relation) in arkworks
(ark-r1cs-std / ark-groth16 / ark-bn254 0.5) and proves, with executed evidence,
that its Groth16 proofs **verify under `sui::groth16`** (Move unit test, sui 1.75.0).

## Headline results (measured 2026-07-14, Apple M3 Pro, 11 cores)

| Metric | arkworks (release, parallel) | snarkjs 0.7 (node 25) |
|---|---|---|
| Constraints | 6 334 | 13 611 (`--O1`, project default) / 6 384 (`--O2`) |
| Setup | 100.6 ms | 8 234 ms (`zKey.newZKey`, incl. ptau processing) |
| Prove | 94.7 ms (avg 5) | 464.3 ms (avg 5, witness excluded; witness calc 55.9 ms) |
| Verify | 1.37 ms (0.78 ms with prepared VK) | 7.5 ms (avg 20) |
| Proof size | 128 bytes compressed | 128 bytes after conversion |

Poseidon finding: circomlib's round constants and MDS for BN254 x^5 are
**bit-identical** to what `ark_crypto_primitives::sponge::poseidon::find_poseidon_ark_and_mds`
generates for the same `(t, R_F, R_P)` — both come from the official hadeshash
Grain LFSR. What differs is the **construction**: ark's `PoseidonSponge` over the
same config hashes `[1,2,3,4]` to a different value than circomlib
(`78177…3245` vs `18821…7333`). This spike therefore ships a faithful gadget of
the circom permutation (`src/poseidon.rs`), giving full hash parity: same
commitments, same nullifiers, same Merkle roots. **No re-hashing of the
commitment tree is needed.** The Groth16 VK still changes (different R1CS →
different setup), requiring the on-chain VK timelock update path.

## Layout

- `src/poseidon.rs` — circom-compatible Poseidon: native (light-poseidon, ships
  circomlib constants) + `FpVar` R1CS gadget of the reference permutation
- `src/circuit.rs` — `TransferCircuit` (`ConstraintSynthesizer`): all constraints
  of transfer.circom (Merkle depth 20, commitment binding, sum, txAmount > 0,
  64-bit ranges, threshold bound, nullifier, txAmountHash); public inputs in the
  exact on-chain order
- `src/witness.rs` — canonical witness, mirrors `js/gen_input.mjs`; ground-truth
  constants produced by circomlibjs
- `src/sui.rs` — serialization to the `sui::groth16` byte layout (arkworks
  `serialize_compressed` *is* the format; cross-checked against a Rust port of
  `scripts/src/proof-converter.ts`)
- `src/bin/bench.rs` — measured benchmarks
- `src/bin/export_sui.rs` — deterministic setup + proof, writes `out/*.hex` and
  generates `move-verify/sources/verify_test.move`
- `src/bin/poseidon_compare.rs` — the Poseidon constants/construction evidence
- `js/gen_input.mjs` — circomlibjs ground truth + snarkjs `input.json`
- `js/bench_snarkjs.mjs` — snarkjs benchmark on the freshly compiled circuit
- `move-verify/` — Move package whose unit test calls
  `sui::groth16::verify_groth16_proof` with the arkworks bytes

## How to run

```bash
cd experiments/arkworks

# 1. Rust test suite (10 tests: poseidon parity, groth16 e2e, negative
#    witnesses, sui byte-layout parity)
cargo test

# 2. Poseidon constants/construction comparison
cargo run --bin poseidon_compare

# 3. Benchmarks (release)
cargo run --release --bin bench

# 4. Export proof/vk/public inputs for Sui + regenerate the Move test
cargo run --release --bin export_sui

# 5. Verify on-chain semantics via Move unit test (needs sui >= ~1.45;
#    a working 1.75.0 binary lives at /tmp/sui-devnet-175/sui)
cd move-verify && /tmp/sui-devnet-175/sui move test

# 6. snarkjs comparison (compiles the CURRENT transfer.circom — the artifacts
#    in circuits/build/ are stale: 6 public inputs, no Merkle stage)
cd ..
mkdir -p build-circom
circom ../../circuits/transfer.circom --r1cs --wasm -o build-circom -l ../../circuits
node js/gen_input.mjs        # regenerates js/input.json + ground truth
node js/bench_snarkjs.mjs
```

## Caveats

- `export_sui` uses a seeded RNG (`StdRng::seed_from_u64(42)`) so the Move test
  bytes are reproducible. That is obviously not a trusted setup.
- `circuits/build/transfer.r1cs` / `transfer_vk.json` predate the Merkle
  accumulator (6 public inputs, 3 211 constraints). The deployed VK should be
  re-checked against a fresh compile before relying on those artifacts.
- Adopting arkworks as prover keeps every existing commitment/nullifier valid
  (hash parity), but the VK produced by ark-groth16 setup differs from the
  snarkjs zkey VK, so switching provers means a VK update on-chain (1-epoch
  timelock) and re-running a trusted setup ceremony in the arkworks stack.
