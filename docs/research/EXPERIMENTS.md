# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

Re-ranked 2026-09-15: on-chain gas per entry point (previously #1) is now **KEEP** in `LEDGER.md` —
removed from the queue, see `BASELINE.md`. It also settled a question item #3 was implicitly
blocked on and reshaped its framing (see #2 below). The chained-`npm test`-hang item (previously
#12) was fixed in a separate PR before tonight (`f942fca`, explicit `process.exit(0)` after the
last proof in all three circuit test runners) — also removed, nothing left to do there.

1. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`), and constraint count is what drives **proving** time
   (751ms/738ms vs. 244ms per `BASELINE.md`) — 2026-09-15 confirmed proving time and on-chain
   verification gas are governed by two *different* things (constraints vs. public-input count),
   so this is squarely a proving-time lever, not a gas one. A measured constraint-count and
   proving-time delta from swapping to Poseidon2 is the highest-leverage next number: it's the
   actual UX latency users feel, on every transfer, and nothing blocks it.

2. **Batched/aggregated proof verification (N transfers → 1 on-chain verify), re-scoped by
   2026-09-15's gas finding.** Groth16 verification computation cost is flat (Sui's cheapest gas
   bucket) regardless of circuit size *or proof count* — `compliant_transfer`'s two verifications
   cost the same computation as `shielded_transfer`'s one. So naively batching N verifications into
   one PTB call would save little; the real lever is **storage** — N separate dynamic-field writes
   (one nullifier + one commitment each) vs. some batched insertion. Now unblocked (real per-op gas
   numbers exist in `BASELINE.md`) but needs a genuine storage-layout redesign to be worth doing,
   not just a wrapper. Worth a small real 2-transfer-in-one-PTB measurement first to confirm the
   hypothesis before designing anything bigger.

3. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). Now also has a real
   `update_commitment_root` gas number (`BASELINE.md`: ~0.0013 SUI net for a single-leaf update) to
   extrapolate batch-insertion cost from.

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

7. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
   (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
   profile (`page.emulate(...)`) and compare against the desktop-headless numbers already in
   `BASELINE.md`. Good "spend an hour, get a real number" candidate for a lighter night.

8. **Gas under concurrent load / shared-object contention.** 2026-09-15's gas numbers are from a
   single-validator local network processing one transaction at a time. Real gas (and, more
   importantly, latency/failure rate) for concurrent `shielded_transfer`s against the same shared
   `Pool` object is unmeasured — relevant to whether the current UTXO-dynamic-field design becomes
   a bottleneck under real traffic.

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
