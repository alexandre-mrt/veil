---
name: veil-zk
description: >
  Veil's ZK stack: Circom 2.1 circuits (transfer / compliance / withdraw) compiled with circom and
  proven with snarkjs 0.7 Groth16 over BN254, verified on-chain by sui::groth16. Use for writing or
  reviewing circuit code (Poseidon domain tags, MerkleProof template, Num2Bits range checks,
  GreaterThan/LessEqThan comparators, under-constrained signals, alias/wraparound bugs), constraint
  budgeting, the trusted setup and powers-of-tau, verifying-key handling and timelocked VK updates,
  and the exact snarkjs-to-arkworks byte conversion (compressed G1/G2, little-endian, sign bits,
  128-byte proofs) that Sui expects. Symptoms: "proof verifies locally but fails on-chain",
  "invalid scalar", EInvalidScalar, ETooManyPublicInputs, wrong public-input order. For protocol
  semantics see /veil-protocol; for browser proving see /veil-frontend; for compile/deploy commands
  see /veil-ops.
last_updated: 2026-07-14
---

# Veil ZK Stack

**Circom 2.1 + snarkjs 0.7, BN254 Groth16, verified by `sui::groth16`.** There is no Rust and no
arkworks code in this repo. arkworks matters in exactly one place — it defines the byte layout
`sui::groth16` parses — and that conversion is written in TypeScript
(`scripts/src/proof-converter.ts`, mirrored in `frontend/src/lib/proof-converter.ts`).

Circuits: `circuits/transfer.circom`, `circuits/compliance.circom`, `circuits/withdraw.circom`,
shared template `circuits/templates/merkle_proof.circom`.

## The three circuits

| Circuit | Public inputs | Purpose |
|---|---|---|
| `transfer` | 7: `oldCommitment, newCommitment, threshold, epochId, nullifier, txAmountHash, merkleRoot` | Spend a commitment, create the next one, prove cumulative ≤ threshold |
| `compliance` | 6: `merkleRoot, currentEpoch, contextId, requiredKycLevel, nullifier, validCredential` | Prove an unexpired KYC credential of sufficient level is in the credential tree |
| `withdraw` | 5: `commitment, withdrawAmount, nullifier, recipientHash, newCommitment` | Prove ownership, exit part of the balance, produce a change commitment |

**Public-input order is load-bearing.** It is fixed by the `component main {public [...]}` line and
the Move contract slices `public_inputs_bytes` positionally. Reordering the list without updating
the contract silently changes what the contract thinks it is checking. Add new public inputs at the
end, and update the contract's offsets in the same commit.

Sui's verifier caps public inputs at 8. Transfer is at 7 — there is one slot left. If you need more,
pack values into a single Poseidon hash in-circuit and expose the hash.

## Poseidon and domain tags

Every hash puts a constant domain tag in `inputs[0]`. The eight tags in use are listed in
`/veil-protocol` — they are global across the three circuits, so a new hash needs a new tag.
`circomlib`'s `Poseidon(n)` is used directly; the `n` is the total input count *including* the tag,
so a commitment `H(1, cumulative, randomness, userSecret)` is `Poseidon(4)`.

Poseidon is chosen because it costs a few hundred R1CS constraints per hash where SHA-256 costs
~25,000. Pedersen commitments (`v*G + r*H`) are never used in-circuit here: EC scalar
multiplication inside R1CS costs thousands of constraints, and there is no need for additive
homomorphism anywhere in the design.

## Merkle membership in-circuit

`templates/merkle_proof.circom` — depth-20 binary Poseidon tree, used by both `transfer` (commitment
tree) and `compliance` (credential tree):

```circom
template MerkleProof(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;   // booleanity — do not remove
        mux[i] = MultiMux1(2);                          // order (node,sibling) or (sibling,node)
        ...
        hashers[i] = Poseidon(2);
        nodes[i + 1] <== hashers[i].out;
    }
    root <== nodes[depth];
}
```

The `pathIndices[i] * (1 - pathIndices[i]) === 0` line is the whole security of the path. Without
it, `pathIndices[i]` is an arbitrary field element, `MultiMux1` interpolates between the two
branches, and a prover can hash a leaf that is in no tree into any root they like. This is the
canonical Merkle-in-circuit bug.

The off-chain tree (`frontend/src/lib/merkle-tree.ts`) must agree bit-for-bit: same depth (20), same
`Poseidon(2)` for internal nodes, `ZERO_VALUE = 0` and precomputed zero hashes
(`zeroHashes[i] = H(zeroHashes[i-1], zeroHashes[i-1])`) for padding. A mismatch here produces a
proof that verifies in snarkjs and fails against the on-chain root.

## Range checks and comparators — the sharp edges

Circom signals are BN254 field elements (~254 bits), not u64. Everything the protocol treats as a
number needs an explicit `Num2Bits(64)`:

```circom
component txBits = Num2Bits(64);
txBits.in <== txAmount;
```

**Why:** `p - 5` is a perfectly valid field element that behaves like `-5` under addition. Without a
range check, `cumulativeNew === cumulativeOld + txAmount` can be satisfied with a "negative"
`txAmount` that *decreases* the cumulative counter, or with a huge `cumulativeOld` that wraps around
to something small. `transfer.circom` range-checks `cumulativeOld`, `txAmount`, `cumulativeNew` **and**
`threshold` for exactly this reason. Range-checking only the result is not enough — both operands
must be constrained independently.

**Comparator bit widths must match the range check.** `GreaterEqThan(8)` on `kycLevel` is only sound
because `kycLevel` is separately constrained by `Num2Bits(8)`; otherwise a large field element wraps
inside the comparator and compares as small (this was audit finding SKILL-002, and the same fix had
to be applied to `requiredKycLevel`). Rule: for every `GreaterThan(k)` / `LessEqThan(k)` /
`GreaterEqThan(k)`, both operands must have a `Num2Bits(k)` — or be a constant.

**Comparator outputs are only booleans if you say so.** `compliance.circom` adds, defensively:

```circom
expiryCheck.out * (1 - expiryCheck.out) === 0;
kycCheck.out   * (1 - kycCheck.out)   === 0;
```

before multiplying them into `validCredential`. Belt-and-braces against a malformed comparator
producing a non-binary output that makes the AND come out to 1.

**A comparator you do not `===` is not enforced.** `component gtZero = GreaterThan(64); ... gtZero.out === 1;`
— the last line is the constraint. Instantiating the comparator and reading `.out` without asserting
it does nothing at all. Grep for any `GreaterThan`/`LessEqThan` whose `.out` is never used in a
constraint or multiplied into an output.

## Constraint budget

`compile.sh` prints the real number via `snarkjs r1cs info`. Trust that, not an estimate. Rough
shape: the depth-20 Merkle proof dominates every circuit that has one (20 × `Poseidon(2)`), Poseidon
hashes are a few hundred constraints each, and a 64-bit `Num2Bits` is ~64. All three circuits fit
comfortably under `pot15` (2^15 = 32,768 constraints), which is the powers-of-tau file `compile.sh`
downloads.

If a circuit outgrows 2^15, the ptau file must move up a size (`powersOfTau28_hez_final_16.ptau`,
etc.) — and the setup must be re-run, which means a new VK, which means a timelocked VK update
on-chain.

## Trusted setup

`circuits/scripts/compile.sh` runs: `circom --r1cs --wasm --sym` → download `pot15_final.ptau` →
`snarkjs groth16 setup` → **one** dev contribution → export VK. It prints a loud warning, and it
should: a single-contributor setup means whoever ran it holds the toxic waste and can forge proofs
for anything — including minting tokens from nothing. `circuits/scripts/ceremony.sh` is the
multi-contributor path; production needs it. Per-circuit variants:
`compile-compliance.sh`, `compile-withdraw.sh`.

## Verifying keys on-chain

VKs are stored as **raw compressed bytes** on the `Pool` / `ComplianceConfig`, and `verifier.move`
calls `groth16::prepare_verifying_key` on **every** verification. That costs ~82K gas per call and
is a known, documented trade (simplicity over gas — see the note at the top of `verifier.move`). If
you optimize it, store the `PreparedVerifyingKey` at pool creation and use `pvk_from_bytes`; do not
half-do it.

Every VK slot (transfer, withdraw, compliance) is behind a **1-epoch timelock**: propose → wait →
apply, with a cancel path. An instant VK swap is a rug — the admin installs a key they hold the
toxic waste for and drains the pool. `E_VK_UPDATE_PENDING`, `E_INVALID_VK_LENGTH` (min 232 bytes).

## snarkjs → Sui bytes (the arkworks layout)

This is the single most error-prone step, and the place where "verifies locally, fails on-chain"
comes from. `sui::groth16` parses **arkworks compressed BN254 serialization**. snarkjs emits JSON
with decimal-string coordinates. `proof-converter.ts` bridges them; 109 unit tests plus E2E on
testnet pin the behaviour.

**Field element → 32 bytes little-endian.** Not big-endian. Tools from the EVM world (ethers,
solidity verifiers) hand you big-endian and it will fail silently.

**G1 compressed = 32 bytes:** x in LE, sign bit `0x80` OR'd into `bytes[31]` if `y > (q-1)/2`.

**G2 compressed = 64 bytes:** `[x0 LE 32 | x1 LE 32]`, sign bit in `bytes[63]`, set by lexicographic
comparison of `(y1, y0)` against `Q_HALF`.

> **snarkjs already stores G2 in `(c0, c1)` order — no coordinate swap is needed.** This contradicts
> a lot of blog posts and half the converters on GitHub, which swap `c0`/`c1`. Verified here by the
> converter test suite and by real transactions on Sui testnet. If you "fix" this by adding a swap,
> every proof will start failing on-chain while still passing `snarkjs.groth16.verify`.

**Proof = 128 bytes:** `A (G1, 32) || B (G2, 64) || C (G1, 32)`.

**Public inputs:** each signal as 32-byte LE, concatenated. `N * 32` bytes, `N <= 8`.

**VK bytes:** `alpha_g1 (32) || beta_g2 (64) || gamma_g2 (64) || delta_g2 (64) || ic_len (u64 LE, 8) ||
IC[i] (32 each)`. Total `232 + n*32`, which is where `MIN_VK_LENGTH = 232` in the contract comes from.

Two field moduli, and mixing them up is a classic bug:

```
Fq (coordinates) = 21888242871839275222246405745257275088696311157297823662689037894645226208583
Fr (scalars)     = 21888242871839275222246405745257275088548364400416034343698204186575808495617
```

Sign bits compare against `Q_HALF = (Fq - 1) / 2`. Public inputs must be `< Fr` or Sui aborts with
`EInvalidScalar`.

## Debugging "verifies locally, fails on-chain"

Work down this list in order — it is almost always one of the first three:

1. **Verify locally first.** `snarkjs.groth16.verify(vk, publicSignals, proof)`. If that fails, the
   bug is in the circuit or the witness, not the conversion.
2. **Check the byte lengths.** Proof exactly 128. Public inputs exactly `N * 32`. VK `232 + n*32`,
   where `n` = number of public inputs, so IC has `n + 1` points.
3. **Check public-input order** against the `component main {public [...]}` list and against the
   offsets the Move contract slices.
4. **Check endianness** — print the hex of one public input from TS and compare with what the
   contract sees.
5. **Check the VK matches the zkey** the proof was generated from. Recompiling a circuit produces a
   new VK; an on-chain VK from a previous build rejects every new proof with no useful error.
6. **Check the root.** A transfer proof against a Merkle root that has not been published on-chain
   yet fails with `E_MERKLE_ROOT_MISMATCH`, which looks like a proof failure but is not one.

## Circuit review checklist

Run through this on any circuit change:

- Every user-supplied numeric signal has a `Num2Bits(k)` with `k` matching every comparator it feeds.
- Every comparator's `.out` is actually constrained (`=== 1`) or multiplied into a constrained output.
- `pathIndices` booleanity constraint is present in any Merkle template.
- Every Poseidon call has a domain tag in `inputs[0]`, and the tag is new or correct.
- No signal is assigned with `<--` without a matching `===` constraint (`<--` computes, it does not
  constrain; `<==` does both).
- The `component main {public [...]}` list matches the contract's expected input order and count.
- Adding an input changed the VK — a VK update is required, and it is timelocked.
- Constraint count still fits the ptau file.
