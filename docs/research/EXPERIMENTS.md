# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Fix E7: on-chain recipient binding in `zk_withdraw`.** (New, 2026-11-19 — a live fund-
   redirection bug, so it outranks every performance item.) `zk_withdraw` must recompute
   `Poseidon(8, recipient_field)` with `sui::poseidon::poseidon_bn254` and compare it to public-input
   bytes 96..128. Needs a canonical address→field mapping (Sui addresses are 256-bit; BN254 r is
   ~254-bit — truncation vs two-limb circuit change vs `mod r` with collision analysis), a soundness
   argument, an on-chain negative test (the redirect probe in `scripts/bench/gas-localnet.mjs` must
   flip from REDIRECTED to rejected), and the gas delta of on-chain Poseidon (same harness).

2. **Computation headroom under the 1,000-unit floor.** (New.) Micro-benchmark package looping `k`
   Groth16 verifies / Poseidon hashes per tx to find where computation leaves the floor. Tells us
   whether item 1's on-chain Poseidon and any batching are free or not. Cheap — reuses the localnet
   harness.

3. **Pool-object storage churn / shared-object contention.** (New.) The 2026-11-19 baseline shows
   transfer cost is ~14.5M MIST storage charged / ~12.4M rebated per tx from rewriting the shared
   `Pool`. Measure a slimmer hot object and concurrent-transfer throughput on localnet.

4. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance from the current baseline) is the highest-leverage next number — it moves prover time
   directly, for every circuit, on every transfer.

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
    port, not a parameter change — so this should wait until items 1–2 give a clearer picture of
    what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

11. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
     computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
     experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
     migration path would cost, not a benchmark.

12. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
     (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
     sender-relayer pairs under concurrent load) is unmeasured.

13. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Re-ranked down 2026-11-19: a single verify already sits under Sui's 1,000-unit computation floor,
    so N→1 aggregation saves ~0 fees on Sui — its remaining value is throughput/contention. Originally: reduces the
    per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
    Depends on item 1 existing first (need a real per-verify gas number to know how much this would
    actually save).

~~14. Fix `circuits`' chained `npm test` hang.~~ Done in #17 (explicit `process.exit` after the last proof); `npm test` runs all three files end-to-end as of 2026-11-19.
