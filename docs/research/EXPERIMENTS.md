# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification. Was blocked on a real per-verify gas
   number to size the savings against — **unblocked 2026-09-20**: `shielded_transfer` costs
   3,818,764 net MIST per call today (`BASELINE.md`), almost entirely storage, not the Groth16
   verify itself (see that report's computation-cost-bucketing finding). That finding also means
   the honest way to frame this experiment changed: batching won't reduce *verification* cost much
   (it's already cheap/bucketed) — its real upside is amortizing the *storage* writes (nullifier,
   commitment) across N transfers into fewer transactions, which is a different, still-real saving
   worth measuring directly rather than assuming.

2. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability). Was blocked on real
   `deposit_and_register`/`update_commitment_root` gas numbers — **unblocked 2026-09-20**
   (`BASELINE.md`: 2,775,588 and 2,306,288 net MIST respectively, single-leaf case); now has a real
   per-insertion baseline to project batch-insertion economics against.

3. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 is still the highest-leverage number for *proving time* — it moves prover
   time directly, for every circuit, on every transfer. **Re-ranked down from #2 on 2026-09-20**:
   that night's on-chain gas measurement found Groth16 verification cost doesn't scale with circuit
   size at Veil's scale (`zk_withdraw`, 3,058 constraints, costs *more* net gas than
   `shielded_transfer`, 13,611 constraints — storage dominates, not proof complexity). So Poseidon2
   should be scoped and reported honestly as a client-side proving-time/UX experiment, not an
   on-chain cost experiment — still worth doing (proving time is real, measured, user-facing
   latency), just not the "moves gas too" story it looked like before items 1 and 2 above had real
   numbers to compare against.

4. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented.

5. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.
   A t-of-n threshold scheme (or even measuring the cost of a naive N-of-N re-encryption) changes
   the trust model for compliance data meaningfully and is a natural fit for the "confidential
   payroll with a t-of-n auditor board" use case named in the 2026-07-22 report.

6. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock). An
   RSA or Merkle-based revocation accumulator could make single-credential revocation cheaper
   without a full root rebuild — worth a real cost comparison, not just a design note.

7. **Gas under shared-object contention (concurrent transfers on one `Pool`).** The 2026-09-20 gas
   numbers in `BASELINE.md` are strictly sequential on an idle single-validator network — no
   congestion pricing, no consensus delay from competing writers to the same shared `Pool` object.
   Real concurrent-load behavior (many `shielded_transfer`/`zk_withdraw` calls against the same pool
   at once) is a materially different, still-unmeasured question directly relevant to a
   throughput/DoS-cost analysis. `scripts/bench/onchain-gas.mjs`'s local-network setup extends
   naturally to firing concurrent `sui client call`s once a design for the load pattern exists.

8. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
   (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
   profile (`page.emulate(...)`) and compare against the desktop-headless numbers already in
   `BASELINE.md`. Good "spend an hour, get a real number" candidate for a lighter night.

9. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
   `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
   port, not a parameter change — so this should wait until items above give a clearer picture of
   what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

10. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

11. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

12. **Fix `circuits`' chained `npm test` hang.** Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run: real (non-hash-only) `snarkjs.groth16`
    calls leave the Node process alive after the test file finishes printing results, which stalls
    the `&&`-chained `npm test` script after the first file. Each file passes fine run
    individually (reconfirmed 2026-09-20, all three circuit test files run standalone). Low
    priority; fold into whichever future night touches `circuits/test/`.
