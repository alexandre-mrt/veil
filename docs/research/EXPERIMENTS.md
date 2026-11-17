# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

Re-ranked 2026-11-17: the gas baseline (old #1) is settled KEEP. Two critical binding bugs it
uncovered go straight to the top — an unmitigated, demonstrated theft path outranks any performance
number. Batching (old #3) drops: on Sui, verification is billed in the minimum computation bucket,
so its savings case now rests on storage/contention, not pairings.

1. **Fix: bind `zk_withdraw` recipient on-chain** (threat-model E7/RR10, critical). Compute
   `sui::poseidon::poseidon_bn254([8, recipient mod p])` in `pool::zk_withdraw`, assert it equals
   public-input bytes 96..128. Deliver with a negative test using a real proof (reuse
   `scripts/bench/gas-localnet.ts`'s recipient probe — it must flip to REJECTED) and the gas delta
   (does on-chain Poseidon leave the 1,000-unit bucket?).

2. **Fix: bind the compliance proof to its transfer** (E8/RR11, high). Circuit change: compliance
   recomputes the transfer nullifier `Poseidon(2, userSecret, epochId, randomnessOld)` and exposes it
   publicly; `compliant_transfer` asserts equality with transfer bytes 128..160. Needs soundness
   argument, leakage analysis (expected nil — both proofs already share a transaction), negative
   test (harness's binding probe must flip to REJECTED), constraint/proving-time delta.

3. **Shrink the `Pool` shared object.** Storage, not verification, is what every call pays
   (2026-11-17). Move VKs / pending-update fields into separate objects (immutable VK objects swapped
   by timelocked pointer) and measure net MIST per transfer with `gas-localnet.ts`.

4. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance from the current baseline) is the highest-leverage next number — it moves prover time
   directly, for every circuit, on every transfer. (Note 2026-11-17: Poseidon2 moves *prover* time
   only — on-chain cost is unaffected since verification is bucket-floor billed.)

5. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   2026-11-17 gas baseline: a verify is billed in the minimum 1,000-unit bucket, so batching saves
   ~nothing in computation today; the case must be made on per-transfer object writes and `Pool`
   contention. Measure where N verifies in one PTB leaves the minimum bucket first.

6. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow).

7. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented. 2026-11-17 evidence that this matters: both
   binding bugs (#1, #2) live at the circuit↔Move seam, which neither the circuit tests nor the
   proof-free Move tests exercise — audit the seam (every public input: who checks it on-chain?).

8. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.
   A t-of-n threshold scheme (or even measuring the cost of a naive N-of-N re-encryption) changes
   the trust model for compliance data meaningfully and is a natural fit for the "confidential
   payroll with a t-of-n auditor board" use case named in the 2026-07-22 report.

9. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock). An
   RSA or Merkle-based revocation accumulator could make single-credential revocation cheaper
   without a full root rebuild — worth a real cost comparison, not just a design note.

10. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
   (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
   profile (`page.emulate(...)`) and compare against the desktop-headless numbers already in
   `BASELINE.md`. Good "spend an hour, get a real number" candidate for a lighter night.

11. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
   `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
   port, not a parameter change — so this should wait until items 1–2 give a clearer picture of
   what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

12. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

13. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

14. ~~**Fix `circuits`' chained `npm test` hang.**~~ Done in #17 (explicit exit after the last
    proof); 2026-11-17 `npm test` ran all three files end-to-end (43/30/35 passed).
