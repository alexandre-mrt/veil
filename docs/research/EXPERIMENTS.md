# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

Re-ranked 2026-10-02 after the on-chain gas baseline (LEDGER 2026-10-02): the old #1 (gas) is settled
KEEP; a confirmed security finding (F1) jumps to the top; batched proofs is demoted because verification
sits entirely under Sui's 1,000-unit computation floor.

1. **Fix `zk_withdraw` recipient binding (F1) and measure the fix.** `zk_withdraw` ignores the
   `recipientHash` public input, so a valid proof can be redirected to any address (confirmed on-chain,
   `2026-10-02-onchain-gas-baseline.md`). Recompute `Poseidon(8, recipient)` on-chain with
   `sui::poseidon::poseidon_bn254`, or expose `recipient` as a public input; settle the 256-bit
   address → ~254-bit field mapping; add the missing negative Move test; measure extra gas with
   `scripts/bench/gas-bench.ts` (still under the floor?). Unmitigated threat → highest value.

2. **Contract ↔ circuit binding audit.** F1 passed 43+30+35 circuit tests and 124 Move tests. Check every
   public input of all three circuits is compared on-chain or provably unneeded; in particular whether
   `compliant_transfer`'s compliance proof is bound to the transfer proof it accompanies (`contextId` is
   private in the compliance circuit; the contract never relates the two proofs). Fold in the old
   "independent soundness audit" scope (alias checks beyond T30, nullifier collisions across the eight
   domain tags, malleability).

3. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Unchanged from before: transfer and
   compliance have 6,470 / 6,057 non-linear constraints driven by four Poseidon instances vs 1,465 for
   withdraw; a measured constraint/proving-time delta moves prover time on every transfer. (Note: any
   hash change interacts with F1's on-chain Poseidon, so do #1 first.)

4. **Storage footprint per transfer.** New. Gas is storage-dominated: a transfer pays ≈ 14.5 M MIST
   storage (≈ 3.1 M net) against a 1.0 M computation floor. Break down which objects/dynamic fields cost
   what, and test whether e.g. nullifier-only sets or Merkle-leaf commitments (instead of one dynamic
   field per commitment) cut it. Replaces batching as the real gas lever.

5. **Merkle accumulator at scale (10^5–10^7 commitments).** Unchanged: batch insertion cost, depth-20 vs
   deeper (anonymity set vs proving time), indexer throughput; threat-model RR5. Overlaps #4.

6. **Threshold auditing (t-of-n) vs the single auditor key.** Unchanged. New datum: ≈ 3 full
   Groth16 verifications fit under the computation floor, so a multi-proof auditor design is not
   compute-limited.

7. **Mobile WASM proving latency.** Unchanged; cheap extension of `scripts/bench/browser-latency.mjs`
   (add a mobile device-emulation profile). Good candidate for a light night. Re-check the ptau caveat.

8. **Shared-object (`Pool`) contention under concurrent transfers.** New. Everything touches one shared
   object; measure throughput with concurrent submissions using the gas-bench harness (localnet
   single-validator limits what it can show — may need multi-validator genesis).

9. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** *Demoted.* Measured
   verification ≈ 235–270 units per proof, entirely absorbed by the 1,000-unit floor, so batching saves
   0 MIST today. Revisit only if (a) a design pushes total computation over the floor (many proofs per tx,
   on-chain Poseidon from #1 plus heavier checks) or (b) Sui's pricing changes.

10. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Unchanged.

11. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Unchanged; large lift. Note the
    verification budget above: a PLONK-family verifier is likely to cost far more than Groth16's ~180 units
    and could leave the floor — measure with `gas-probe` before committing.

12. **Post-quantum exposure.** Unchanged; design-only, UNMEASURED label.

13. **Relayer throughput and leakage under load.** Unchanged. F1 makes the relayer's trust position more
    important (a relayer can currently redirect withdrawals) — do after #1.

14. **Housekeeping.** Confirm a live-network RGP/storage-price check and a Hermez-ptau re-run of the
    proving-time rows (see report Open questions #5). (The earlier "chained `npm test` hang" item was
    fixed in `f942fca`; dropped.)
