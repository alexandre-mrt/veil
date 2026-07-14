---
name: veil-arkworks
description: >
  RESEARCH TRACK — not what Veil runs today. Rust/arkworks proving stack, explored on a branch as
  the scalability axis: recursion and folding (Nova/HyperNova/SuperNova), proof aggregation and
  batched verification, and a native Rust prover to replace browser snarkjs. Use when writing or
  reviewing arkworks circuit code (ConstraintSynthesizer, FpVar, Boolean, enforce_cmp,
  ark-crypto-primitives Poseidon and Merkle gadgets, ark-groth16 setup/prove/verify,
  CanonicalSerialize), when picking a folding scheme or an aggregation strategy, or when hitting
  arkworks build pain (r1cs vs gr1cs namespace, [patch.crates-io] duplicate-type errors). Veil's
  shipped circuits are Circom/snarkjs — see /veil-zk, which also owns the snarkjs-to-arkworks
  proof-byte layout that is the one place arkworks is already real in main.
last_updated: 2026-07-14
---

# Veil × arkworks — research track

> **Status: research, not production.** Veil's shipped proving stack is **Circom 2.1 + snarkjs 0.7**
> (`circuits/*.circom`, proofs generated in TypeScript and in-browser). There is **no `Cargo.toml`
> anywhere in this repo** and no Rust circuit code. Everything below describes work that lives on a
> research branch or in a scratch crate, and an autonomous agent must not treat it as a description
> of `main`. Do not "fix" `main` to match this skill.

**Where arkworks is already real in main:** `sui::groth16` parses arkworks' compressed BN254
serialization, so `scripts/src/proof-converter.ts` and `frontend/src/lib/proof-converter.ts`
translate snarkjs JSON into that exact byte layout. That layout is documented once, in **`/veil-zk`**.
Do not duplicate it here.

## Why this track exists

Circom/snarkjs got Veil to a working, audited protocol. It has three ceilings, and each one is a
Rust/arkworks question:

1. **Proving cost is linear in history.** Today every transfer proves a fresh depth-20 Merkle
   membership. Recursion/folding would let a user carry a succinct proof of their whole spending
   history instead of re-proving membership from scratch.
2. **Verification cost is per-proof.** A Tier-3 compliant transfer verifies **two** Groth16 proofs
   on-chain, each paying `prepare_verifying_key` (~82K gas) plus ~115K verify. Aggregation would
   collapse N proofs into one.
3. **The prover is a browser.** snarkjs in the main thread is the UX bottleneck. A native Rust
   prover (server-side, or WASM-compiled from the same source) is the obvious lever.

## Concrete experiments worth running

**E1 — Circom → arkworks parity harness.** Port `transfer.circom` to an arkworks
`ConstraintSynthesizer` and assert both produce the *same* public outputs on the same witness, and
that a proof from either verifies against `sui::groth16` on testnet. **Metric:** proving time
(browser snarkjs vs native arkworks, same circuit) and constraint count delta. This is the
prerequisite for everything else — without parity, no folding result is trustworthy.

**E2 — Nova folding for cumulative spending.** The transfer circuit is an *incrementally verifiable
computation*: state `(cumulative, commitment)`, step function `spend(txAmount)`. That is exactly
Nova's shape. Fold N transfers into one proof, verified once. **Metric:** on-chain gas for N
transfers (today: N × ~200K) and prover time per additional step (should be ~constant, not growing
with N). Caveat to test early: Nova wants a cycle of curves; BN254/Grumpkin is the standard pairing,
and the *final* SNARK still has to be a BN254 Groth16 that `sui::groth16` accepts.

**E3 — Aggregating the dual compliance proof.** Tier 3 currently pays for two independent Groth16
verifications. Either merge transfer + compliance into one circuit (simpler, bigger circuit, one
proof) or aggregate the two proofs (SnarkPack-style). **Metric:** gas per compliant transfer, and
whether merging breaks the context-binding privacy property — the compliance circuit deliberately
keeps `transferNullifier` *private* (see `/veil-protocol`), and a naive merge would leak it.

## arkworks essentials

Everything in a circuit is `ark_bn254::Fr` — the BN254 scalar field. Amounts, hashes, commitments,
all field elements. Two worlds coexist: native Rust (concrete values, off-chain) and R1CS
(`FpVar`/`Boolean`, constraint generation). A circuit struct carries `Option<Fr>` witnesses: `None`
during setup (structure only), `Some` during proving.

```rust
use ark_bn254::{Bn254, Fr};
use ark_relations::gr1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_r1cs_std::prelude::*;
use ark_r1cs_std::fields::fp::FpVar;

impl ConstraintSynthesizer<Fr> for MyCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        // Allocation. new_input ORDER defines public_inputs[i] — it is an ABI.
        let secret = FpVar::new_witness(cs.clone(), || {
            self.secret.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let hash = FpVar::new_input(cs.clone(), || {
            self.public_hash.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let params = CRHParametersVar::new_constant(cs.clone(), &self.poseidon_params)?;

        let computed = PoseidonCRHGadget::<Fr>::evaluate(&params, &[secret])?;
        computed.enforce_equal(&hash)?;
        Ok(())
    }
}
```

Groth16 lifecycle:

```rust
let (pk, vk) = Groth16::<Bn254>::setup(circuit_with_none_witnesses, &mut rng)?;
let proof    = Groth16::<Bn254>::prove(&pk, circuit_with_some_witnesses, &mut rng)?;
let pvk      = Groth16::<Bn254>::process_vk(&vk)?;
let ok       = Groth16::<Bn254>::verify_with_processed_vk(&pvk, &public_inputs, &proof)?;
```

Serialization for Sui is `serialize_compressed()` — VK variable-length, proof exactly 128 bytes,
each public input 32 bytes little-endian. That is the same layout the TypeScript converter builds by
hand; if a Rust prover ever ships, the converter becomes unnecessary for that path.

**Costs (why the design choices are what they are):** field addition is free (linear combination),
multiplication is 1 constraint, `enforce_equal` is 1. Poseidon(2) is ~300–500 constraints; a
Pedersen commitment is 1000+ because it needs in-circuit EC scalar multiplication. `enforce_cmp`
(checked) is ~510 because it range-checks both operands to `(p-1)/2`; if you have already
bit-decomposed to 64 bits, `enforce_cmp_unchecked` saves ~254 constraints per operand. Constants
(`new_constant`) are free — never allocate Poseidon params as a witness.

## Security rules that carry over

1. **Never ship a setup from a seeded RNG.** `StdRng::seed_from_u64(0)` is a test fixture. Production
   needs an MPC ceremony. The Feb 2026 FOOM Cash exploit ($2.26M) skipped Phase 2, leaving
   `gamma_g2 == delta_g2` (both the G2 generator); the attacker forged proofs with `C = -vk_x`.
   **Assert `vk.gamma_g2 != vk.delta_g2` before any VK is deployed** — it is one line and it would
   have caught it.
2. **Groth16 proofs are malleable.** `rerandomize_proof` produces a different valid proof for the
   same statement. Never use proof bytes as an identifier or nullifier. Nullifiers come from
   circuit-internal secrets, exposed as public inputs, tracked on-chain. (This is why Veil's
   nullifiers are Poseidon of `userSecret` — see `/veil-protocol`.)
3. **The contract must validate public inputs, not just the proof.** Same rule as in `main`; see
   `/veil-protocol`.
4. **Sui caps public inputs at 8.** Pack with Poseidon and prove the preimage in-circuit.
5. **`enforce_cmp` is only sound below `(p-1)/2`.** `Fr::from(-1i64)` is `p-1`. Range-check first.

## Build pain (the two that eat an afternoon)

**Namespace.** The 0.4 → 0.5 migration renamed `ark_relations::r1cs` to `ark_relations::gr1cs` (and
`R1CSVar` → `GR1CSVar`). Check which one the version you actually pinned exports before trusting any
snippet, including these.

**`[patch.crates-io]` is mandatory.** arkworks repos cross-reference each other via git. Without a
full patch section pointing every `ark-*` crate at the same git heads, Cargo resolves two versions of
the same type and you get:

```
error[E0308]: mismatched types -- expected `ark_ff::Fp<...>`, found `ark_ff::Fp<...>`
```

which reads like a compiler bug and is not. Patch `ark-ff`, `ark-ec`, `ark-poly`, `ark-serialize`,
`ark-bn254` (→ `algebra`), `ark-relations`, `ark-snark` (→ `snark`), `ark-r1cs-std`, `ark-groth16`,
`ark-crypto-primitives`.

Other repeat offenders: proving with `None` witnesses (panics `AssignmentMissing` — `None` is for
setup only); public-input order at `verify` not matching `new_input()` order; copying Poseidon
params from the `ark-crypto-primitives` examples, which use `ark_ed_on_bls12_381::Fr`, not BN254;
`serialize_uncompressed` (Sui wants compressed); `MerkleTree::new` needing a power-of-two leaf count.

## Testing

Before ever calling `prove`, check satisfiability — it is instant and it localizes the bug:

```rust
let cs = ConstraintSystem::<Fr>::new_ref();
circuit.generate_constraints(cs.clone())?;
assert!(cs.is_satisfied()?);
println!("constraints: {}", cs.num_constraints());
```

Pair it with a negative test (bad witness ⇒ `!is_satisfied()`) and a constraint-count regression
test — an unexpected jump usually means something got allocated as a witness that should have been a
constant.

Then the full round trip: setup → prove → `verify_with_processed_vk` → `serialize_compressed` and
assert the proof is exactly 128 bytes. And, since the whole point is Sui: submit it to testnet.
Local verification passing while on-chain verification fails is the failure mode this project has
already hit once — the debugging ladder is in `/veil-zk`.

## Performance

`cargo build --release --features parallel` and `RAYON_NUM_THREADS=N`; parallel Rayon across FFT,
MSM and witness generation is a 4–8× swing and is the first thing to check before concluding a
circuit is "too slow". Beyond ~500K constraints, `inline_all_lcs()` during proving can go quadratic
and dominate — a signal to split the circuit rather than optimize gadgets.
