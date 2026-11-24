# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

**Re-rank 2026-11-24.**
- The gas baseline is settled (KEEP), so the old #1 is gone.
- Three demonstrated soundness gaps go straight to the top. Each one is a pool-drain or
  compliance-bypass on the deployed design, which outranks any performance number.
- Batched/aggregated verification drops and is re-scoped. Measured verification is about 273
  computation units against a 1,000-unit floor, so a proof-aggregation scheme saves almost
  nothing. Floor amortization via relayer PTBs is the only computation lever left.
- The circuit soundness audit moves up: the first three cross-boundary probes ever run all failed.
- The `npm test` hang (old #12) was fixed by #17. `npm test` completed in 32 s tonight.

1. **Fix E4: bind note value to the deposit.** `deposit_and_register` stores an arbitrary
   commitment, so `cumulativeOld` is self-declared and a 100-TOKEN deposit can withdraw 300 TOKEN
   (demonstrated, `scripts/bench/gas-localnet.ts` probe E4).
   - Prerequisite: `transfer.circom` reads `cumulativeOld` as epoch spending while
     `withdraw.circom` reads it as balance. Settle one note semantics first.
   - Options: a deposit circuit proving `commitment = Poseidon(1, amount, r, s)` with `amount`
     public, or a note structure that separates balance from the epoch-spending counter.
   - The PR needs a soundness argument, a leakage analysis (amount is already public at deposit
     via denomination), a negative test (the E4 probe must now abort) and a gas delta from the
     harness.

2. **Fix E7: enforce the withdrawal recipient on-chain.** Recompute
   `Poseidon(8, recipient_field)` with `sui::poseidon::poseidon_bn254` in `zk_withdraw` and
   compare it to bytes 96..128.
   - Specify the address→field encoding (a 32-byte address can exceed the BN254 modulus: reduce
     mod p, or split into two limbs, which needs a circuit change).
   - Measure the gas delta; the prediction is that it stays under the 1,000-unit floor
     (UNMEASURED).
   - Negative test: the E7 probe must abort.

3. **Fix BIND: tie the compliance proof to its transfer.** Make `contextId` a public output of
   `transfer.circom` too (computed from the transfer's own nullifier and `userSecret`), and check
   on-chain that the two proofs carry the same `contextId`.
   - That also binds the credential's `userSecret` to the note's.
   - Leakage analysis: `contextId` is already public via the compliance proof in the same tx.
     Show that putting it in the transfer proof adds nothing for plain `shielded_transfer`, or
     add it only in a compliance variant of the circuit.
   - Constraint delta from one extra Poseidon(3).

4. **Independent circuit soundness audit (cross-boundary).** Under-constrained signals, alias
   checks, nullifier collisions across the eight domain tags, proof malleability.
   - The highest-yield angle is now clear: for every public input, check that the contract
     either constrains it or reads it, and that the value it acts on is that input.
   - Tonight's three probes are the template. Turn each into a Move test with fixed proof vectors
     so the suites stop being self-referential.

5. **Relayer PTB batching (re-scoped from "batched/aggregated verification").** Put k
   independent `shielded_transfer` calls in one relayer-submitted PTB.
   - No protocol change is needed. The prediction from measured per-verify cost: k = 3 fits
     under the floor, saving about 2M MIST per 3 transfers, about 20% net (UNMEASURED).
   - Also measure what batching leaks: a relayer grouping users into one tx links them
     temporally.
   - Proof aggregation (SnarkPack / recursion) stays parked unless storage becomes the target.

6. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Prover time is now the
   biggest *performance* cost Veil pays (gas is at the floor). The 2026-07-22 baseline shows
   6,470 / 6,057 non-linear constraints for transfer/compliance.
   - Measure the constraint and proving-time delta of a Poseidon2 swap, or first re-derive the
     per-instance contribution.
   - Coordinate with #1–#3, which change the circuits anyway.

7. **Shared-`Pool` contention.** Every user entry point takes `&mut Pool`, so all transfers go
   through consensus on one object.
   - Measure concurrent `shielded_transfer` throughput on localnet (the `gas-localnet.ts` setup
     plus N parallel senders).
   - Then measure sharding options: per-denomination pools, or nullifier/commitment sets as
     separate objects.
   - The storage-rebate round-trip on the `Pool` object (about 12M MIST gross per tx, 1%
     non-refundable) is a second reason to shrink it.

8. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs
   deeper (anonymity set vs proving time), indexer throughput. The commitment root is
   admin-submitted with a 1-epoch timelock, so measure that liveness/trust cost too. Relevant to
   RR5.

9. **Threshold auditing (t-of-n) vs the single auditor key.** See `docs/auditor-guide.md`.
   Natural fit for "confidential payroll with a t-of-n auditor board".

10. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today a
    single-credential revocation needs a full root rebuild and a 1-epoch timelock. The gas side is
    now known: `update_credential_root` costs 1,330,372 MIST net, so the open question is
    off-chain cost and latency, not gas.

11. **Mobile WASM proving latency.** Cheap extension of `scripts/bench/browser-latency.mjs`
    (`page.emulate` a device descriptor). Good lighter-night item.

12. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Addresses RR2. Large lift; wait
    until #1–#3 settle the circuit shapes.

13. **Post-quantum exposure.** Design-only, UNMEASURED.

14. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts`, unmeasured.
