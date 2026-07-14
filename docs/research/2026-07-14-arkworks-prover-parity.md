# arkworks prover parity — can an arkworks Groth16 proof replace snarkjs for Veil?

Date: 2026-07-14 · Branch: `research/2026-07-14-arkworks-tee` · **Verdict: KEEP** (spike; not yet wired into the protocol)

## Hypothesis

Veil's transfer relation, reimplemented in arkworks (`ark-r1cs-std` / `ark-groth16` / `ark-bn254`),
produces a Groth16 proof that **`sui::groth16` accepts** — the prerequisite for any future recursion
or folding work — and does so without forcing Veil to re-hash its commitment tree. Target metrics:
does it verify on-chain (yes/no), and proving time / constraint count vs snarkjs.

## Threat / privacy model

This is a **prover-implementation** change, not a protocol change. It moves no trust boundary and
weakens no privacy property **provided the relation is identical** — which is exactly what the spike
had to prove, because a subtly different circuit is a silent soundness bug.

- **What it defends / preserves:** the transfer relation is reproduced constraint-for-constraint
  (Merkle depth-20 membership, identity-bound Poseidon(4) commitments, `cumulativeNew = cumulativeOld
  + txAmount`, `txAmount > 0`, four 64-bit range checks, note-based nullifier, domain-separated
  `txAmountHash`). All 7 public inputs are constrained in the on-chain order; the Merkle path is
  bound to the public root. Both the destructor and the reviewer confirmed no under-constrained
  signal and no dropped constraint.
- **What it does NOT change:** the anonymity set, the auditor model, sender privacy — untouched.
- **The one real risk it introduces:** switching provers changes the **verifying key**. The on-chain
  VK-timelock (`E_VK_UPDATE_PENDING`) must be used to roll it, and until then existing proofs are
  made against the old VK. This is an operational cost, self-disclosed, not a soundness hole.
- **Assumptions:** Groth16 needs a per-circuit trusted setup. The spike uses a **seeded RNG** for
  setup — fine for a benchmark, **not** a ceremony. A real deployment still needs a real MPC ceremony;
  arkworks removes none of that.
- **STRIDE map:** no new entry. This is a `Tampering`-surface *equivalence* claim (the arkworks
  circuit must not accept a witness the Circom one would reject), which the non-vacuous negative
  tests discharge.

## The crux — Poseidon parameters — and how it was settled

circomlib's Poseidon and arkworks' Poseidon are **not** the same permutation by default, so the
naive worry was that arkworks would compute different commitments and a different VK, forcing Veil to
re-hash every commitment ever inserted. The spike settled this **numerically**, three ways that agree
digit-for-digit:

- an independent `circomlibjs` run (Veil's own hashing library) on the domain-tagged preimages,
- the Rust `light-poseidon` native hash,
- the in-circuit gadget output.

For the demo witness, `old_commitment`, `new_commitment`, `nullifier`, `txAmountHash` and the depth-20
`merkle_root` all match circomlibjs exactly. `light-poseidon` ships circomlib-identical round
constants and MDS per width, so **the arkworks circuit hashes identically to Circom** — the "no
re-hash needed" conclusion is measured, not assumed. (Residual caveat, disclosed by the reviewer:
this rests on `light-poseidon` matching circomlib for every arity used, anchored by the parity
vectors rather than an explicit round-count assertion.)

## Results — measured (my own re-run, sui 1.75.0)

**The central claim holds:** the arkworks Groth16 proof verifies under `sui::groth16` on-chain.

```
experiments/arkworks $ cargo test --release
test result: ok. 10 passed; 0 failed

experiments/arkworks/move-verify $ /tmp/sui-devnet-175/sui move test
[ PASS ] ark_verify::verify_test::test_arkworks_proof_verifies_on_sui
[ PASS ] ark_verify::verify_test::test_tampered_public_input_rejected
Test result: OK. Total tests: 2; passed: 2; failed: 0
```

The proof bytes fed to the Move test are genuine prover output, not hand-crafted: re-running
`export_sui` regenerates byte-identical bytes (deterministic seeded RNG), and the serialization was
cross-checked offset-by-offset against `scripts/src/proof-converter.ts`.

| metric | arkworks | snarkjs (--O2) | note |
|---|---|---|---|
| constraints | 6 334 | 6 384 | near-identical → complete implementation, no omitted constraints |
| setup | 105 ms | — | seeded, NOT a ceremony |
| prove | 89 ms | — | |
| verify | 1.33 ms | — | off-chain (native) |
| pvk prepare | 796 µs | — | |
| proof size | 128 B | — | standard Groth16/BN254 |

All measured with `std::time::Instant`; the verifier re-ran `bench` and reproduced these within
noise. The "~4.9× faster proving" headline in the crate README compares arkworks (6 334c) against
snarkjs `--O1` (13 611c) and was **not** re-measured — treat it as `UNMEASURED`; the fair `--O2`
comparison is the 6 384-constraint row above.

Negative tests are non-vacuous (confirmed by both verifiers): bad-sum, bogus-Merkle-path, and
over-threshold witnesses are rejected by `cs.is_satisfied() == false` — constraint-system rejection
for the right reason — while the canonical witness satisfies.

## Verdict — KEEP

The spike proves the thing that unblocks everything downstream: **an arkworks proof of Veil's exact
transfer relation is accepted by `sui::groth16`, and the hashing is identical to Circom, so no
commitment-tree migration is required.** That makes a Rust proving stack a real option, and it makes
recursion/folding (queue #7) worth attempting — it now has a verified base to stand on.

It is `KEEP` as a **spike under `experiments/`**, not a protocol change: swapping Veil's live prover
would require a real trusted-setup ceremony and a VK-timelock roll, neither of which belongs in this
PR.

Repo hygiene finding surfaced by both verifiers and worth acting on independently: `circuits/build/
transfer_vk.json` has `nPublic = 6`, but `transfer.circom` now has 7 public inputs (the Merkle
`merkleRoot`) — the committed VK predates the accumulator stage. Check what is actually deployed on
testnet against the current circuit.

## Where this could be used

- **Veil, next step:** the recursion/folding spike (queue #7) — N transfers verified on-chain as one
  proof, amortising `sui::groth16` verify gas. Circom cannot express recursion; arkworks can. This
  spike is the parity floor that made #7 credible.
- **Any Sui protocol proving Groth16 from Rust** rather than a browser: the `sui.rs` serialization
  here is a reusable, offset-verified port of `proof-converter.ts` from arkworks `CanonicalSerialize`
  to the `sui::groth16` byte layout.
- **Thesis:** the measured Circom-vs-arkworks equivalence (same relation, same hashes, on-chain
  verify) is the load-bearing fact for a chapter arguing a folding-based scalability path.

## Open questions → queue

- Recursion/folding (Nova) on this base: what is the on-chain verify gas per transfer at N = 1, 10,
  100? (queue #7, now unblocked.)
- The `light-poseidon` ↔ circomlib parity rests on anchor vectors; add an explicit per-arity round
  constant assertion to make the "no re-hash" guarantee airtight.
- Re-measure the snarkjs column on the same machine so the speedup headline stops being `UNMEASURED`.
