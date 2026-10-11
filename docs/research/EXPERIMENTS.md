# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

> Re-ranked 2026-10-11 after `onchain-gas-baseline` (KEEP): gas is 65 % storage and the verifier
> fits inside the 1,000,000 MIST computation floor, so storage and multi-transfer PTBs jump the
> queue and aggregated verification drops. Item "on-chain gas per entry point" is settled (see
> `LEDGER.md`); its residue — compliance-path gas — is item 3.

1. **Storage footprint of a shielded transfer (new).** 65 % of a transfer's net gas is storage
   (≈ 1,874 bytes written: permanent nullifier dynamic field, new commitment field, event, pool
   mutation). Break the bytes down with the existing `scripts/bench/gas-local.ts` harness and try
   to shrink it (nullifier set as a `Table`/bag or accumulator object, smaller key encoding).
   Direct, measurable, moves the number Veil pays most for.

2. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance from the current baseline) is the highest-leverage next number — it moves prover time
   directly, for every circuit, on every transfer.

3. **Compliance-path gas + multi-transfer PTB (new, cheap).** Drive `compliant_transfer` (two
   proofs — the one entry point that could exceed the computation floor) and test whether 3
   `shielded_transfer` calls in one PTB cost ≈ 1 transfer's computation (verify fits ~3.7× in the
   floor). Harness already exists; needs 3 distinct proofs and the compliance wiring.

4. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** *Demoted 2026-10-11:*
   measured verify is ≈ 270k MIST = 9.4 % of a transfer and sits inside the 1.0M computation floor,
   so aggregation saves ~0 on-chain for a single transfer. Only worth it beyond ~3 verifies per tx
   or for reasons other than gas (throughput / shared-object contention). Revisit after item 3.

5. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow).

6. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented.

7. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.
   A t-of-n threshold scheme (or even measuring the cost of a naive N-of-N re-encryption) changes
   the trust model for compliance data meaningfully and is a natural fit for the "confidential
   payroll with a t-of-n auditor board" use case named in the 2026-07-22 report.

8. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock). An
   RSA or Merkle-based revocation accumulator could make single-credential revocation cheaper
   without a full root rebuild — worth a real cost comparison, not just a design note.

9. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
   (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
   profile (`page.emulate(...)`) and compare against the desktop-headless numbers already in
   `BASELINE.md`. Good "spend an hour, get a real number" candidate for a lighter night.

10. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
   `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
   port, not a parameter change — so this should wait until items 1–3 give a clearer picture of
   what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

11. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

12. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

13. ~~**Fix `circuits`' chained `npm test` hang.**~~ Already fixed upstream by #17 (explicit exits after the last proof); confirmed 2026-10-11 — `npm test` runs all three files. Kept for the record; remove when convenient.
