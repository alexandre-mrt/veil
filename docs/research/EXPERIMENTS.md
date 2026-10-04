# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Fix recipient binding in `zk_withdraw` (F1, from 2026-10-04).** An unmitigated theft path in
   `docs/threat-model.md` E7: the contract never checks `recipient` against the proof's
   `recipientHash`. Candidate fix: make the recipient address (as 2×128-bit limbs) public inputs that
   the contract rebuilds from the `recipient` bytes — no on-chain hash. Needs a circuit change, so
   soundness argument + leakage analysis + a negative test (proof for A rejected when sent to B), and
   a re-measure of `zk_withdraw` gas (more public inputs). Re-ranked to #1 because it is a live
   security hole, not an optimisation.

2. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance) moves prover time directly. Note the 2026-10-04 gas result: on-chain cost does not
   depend on constraint count (verify ≈267 units regardless), so this is a prover-latency win only.

3. **Net storage growth per transfer (≈2.0 M of 3.04 M MIST, 2026-10-04).** The dominant on-chain cost
   is permanent state: one nullifier dynamic field + one commitment field per transfer. Compare the
   current per-field layout with batched nullifier accumulators / bitmaps; measure bytes and MIST per
   N transfers. Replaces the old "aggregation" item as the gas lever.

3b. **Shared-object contention + PTB batching in the relayer.** Measured: 4 transfers in one PTB cost
   −62% computation / −20% net. Unmeasured: k concurrent PTBs on the single `Pool`, and what
   batching leaks (sender↔relayer-tx linkage). Fold in relayer item #11.

3c. **Batched/aggregated proof verification (demoted from #3 on 2026-10-04).** The 2026-10-04 baseline
   put one verify at ≈267 units against a 1,000-unit per-tx floor, so aggregation saves at most
   ≈267 units per extra proof (≈8% of a 4-transfer PTB's net cost). Only revisit if a recursion
   scheme is wanted for a *different* reason (proof size, trusted-setup removal).

4. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow).

5. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented.

6. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.
   A t-of-n threshold scheme (or even measuring the cost of a naive N-of-N re-encryption) changes
   the trust model for compliance data meaningfully and is a natural fit for the "confidential
   payroll with a t-of-n auditor board" use case named in the 2026-07-22 report.

7. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock). An
   RSA or Merkle-based revocation accumulator could make single-credential revocation cheaper
   without a full root rebuild — worth a real cost comparison, not just a design note.

8. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
   (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
   profile (`page.emulate(...)`) and compare against the desktop-headless numbers already in
   `BASELINE.md`. Good "spend an hour, get a real number" candidate for a lighter night.

9. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
   `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
   port, not a parameter change — so this should wait until items 1–2 give a clearer picture of
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
    individually. Low priority; fold into whichever future night touches `circuits/test/`.
