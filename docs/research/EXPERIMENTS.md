# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

> **Re-ranked 2026-11-21.** On-chain gas (the old #1) is settled KEEP. Two critical fund-loss
> bugs it surfaced (F1, F2) go to the top: no performance work matters while a 100-TOKEN deposit
> can withdraw 1000. Batching (old #3) moves up, because real per-verify numbers now exist. A
> suspected compliance-binding gap and shared-object contention are new items. Old #2 (Poseidon2)
> drops one slot. Gas showed computation sits on the per-tx floor and storage dominates, so
> constraint count moves prover time but not gas.

1. **Fix F1: bind deposit commitments to the deposited amount, and reconcile the second
   commitment field's meaning (cumulative-spent in `transfer.circom`, balance in
   `withdraw.circom`).** Measured exploit: 100 TOKEN in → 1000 TOKEN out
   (`scripts/bench/gas-localnet.mjs`, 2026-11-21). The fix needs the full circuit-change bundle:
   soundness argument, leakage analysis, negative tests, and the localnet F1 probe flipping to
   REJECTED. Candidate: contract computes `Poseidon(1, amount, inner)` with `sui::poseidon`.

2. **Fix F2: on-chain recipient binding in `zk_withdraw`.** Measured exploit: a proof for A was
   redeemed to B. Make `recipient` public (two 128-bit limbs to avoid field aliasing) or recompute
   `recipientHash` on-chain with `sui::poseidon::poseidon_bn254`. The F2 probe must flip to
   REJECTED.

3. **Compliance-proof binding (suspected).** `compliant_transfer` never reads `contextId`, and no
   constraint ties the compliance proof's `userSecret` to the transfer proof's. Test on localnet
   whether user A's compliance proof can accompany user B's transfer. If it can, that is
   compliance laundering (proof lending).

4. **Batched/aggregated proof verification.** Now grounded: prepare+verify = 268.5 units,
   verify-with-prepared = 183.0, per-tx floor = 1,000 (2026-11-21). Measure a PTB of N
   `shielded_transfer`s against N transactions. Storing a `PreparedVerifyingKey` only matters past
   ~4 verifies per tx.

5. **Shared-`Pool` contention.** Every user call takes `&mut Pool`. Measure latency and abort rate
   for N concurrent transfers on localnet. Compare against sharding the nullifier/commitment sets
   into separate objects. Storage also matters here: each call rewrites ~12.2 M MIST of Pool
   storage (rebated, but fronted).

6. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance from the current baseline) is the highest-leverage next number — it moves prover time
   directly, for every circuit, on every transfer.

7. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow).

8. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented.

9. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.
   A t-of-n threshold scheme (or even measuring the cost of a naive N-of-N re-encryption) changes
   the trust model for compliance data meaningfully and is a natural fit for the "confidential
   payroll with a t-of-n auditor board" use case named in the 2026-07-22 report.

10. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock). An
   RSA or Merkle-based revocation accumulator could make single-credential revocation cheaper
   without a full root rebuild — worth a real cost comparison, not just a design note.

11. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
   (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
   profile (`page.emulate(...)`) and compare against the desktop-headless numbers already in
   `BASELINE.md`. Good "spend an hour, get a real number" candidate for a lighter night.

12. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
   `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
   port, not a parameter change — so this should wait until items 1–2 give a clearer picture of
   what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

13. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

14. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

15. **~~Fix `circuits`' chained `npm test` hang.~~** *Resolved by #17. `npm test` ran all three files to completion on 2026-11-21.* Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run: real (non-hash-only) `snarkjs.groth16`
    calls leave the Node process alive after the test file finishes printing results, which stalls
    the `&&`-chained `npm test` script after the first file. Each file passes fine run
    individually. Low priority; fold into whichever future night touches `circuits/test/`.

16. **`compile*.sh` ptau source.** The Hermez GCS/S3 URLs return 403 from the research sandbox.
    PSE perpetual powers of tau `ppot_0080_15.ptau` works and is a real multi-party ceremony.
    Switch the default (a small tooling fix, not an experiment).
