# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Pin the toolchain so every bench is one command.** *New 2026-10-01, cheap.* (a) The Hermez ptau
   URL in `circuits/scripts/compile*.sh` returns `AccessDenied`; mirror/pin a checksummed ptau or
   script `snarkjs powersoftau` generation (≈ 8 min). (b) Document that `contracts/` needs Sui ≥ 1.81
   (pinned framework uses `dynamic_field::exists`). (c) Fold in the `npm test` chained-hang papercut.
   Every circuit experiment below is blocked on a clean checkout until (a) is fixed.

2. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance from the current baseline) is the highest-leverage next number — it moves prover time
   directly, for every circuit, on every transfer.

3. **Storage-minimal transfers.** *New 2026-10-01.* Net gas per transfer is storage (≈ one permanent
   nullifier field plus Pool rewrite), not compute. Measure a design that stops storing a dynamic
   field per commitment (membership proven against the Merkle root, commitments indexed off-chain) and
   re-run `scripts/bench/gas-localnet.ts`. Interacts with the root-update timelock design.

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

6. **Shared-object contention on the Pool.** *New 2026-10-01.* Every transfer mutates one shared
   `Pool`; extend the gas bench with concurrent senders and measure throughput/latency and failure
   modes. The gas table says single-tx cost is fine; ordering cost is unmeasured.

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

10. **Verifier share of computation + real-network cross-check.** *New 2026-10-01.* Isolate how many of
   the 342 units/transfer are Groth16 (scratch wrapper module around `sui::groth16`), and repeat the
   gas bench on testnet if egress to a fullnode is ever permitted.

11. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** *Re-ranked down on
   2026-10-01:* the first gas baseline shows computation is at the 1,000-unit floor and a transfer's
   real computation is ≈ 342 units of ≈ 3.1M MIST net, so aggregation can save at most ~11% per
   transfer before paying for the aggregation circuit. Revisit only if a large-N relayer batch makes
   the floor irrelevant, or if the verifier share (item 10) turns out to be most of the 342.

12. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
   `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
   port, not a parameter change — so this should wait until items 2–3 give a clearer picture of
   what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

13. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

14. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.
