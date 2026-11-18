# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Fix F1 (deposit-value binding) and F2 (withdraw recipient binding) — CRITICAL, fund loss.**
   Both found and reproduced 2026-11-18 (`2026-11-18-onchain-gas-baseline.md`; threat-model
   E4/E7/RR0a/RR0b). Re-ranked to #1 because both are unmitigated fund-loss threats on deployed
   code, not optimisations. F2: `zk_withdraw` recomputes `sui::poseidon::poseidon_bn254([8,
   recipient_field])` and asserts it equals public-input bytes 96..128. Decide and document the
   256-bit-address → BN254-field mapping, then measure the gas delta with
   `scripts/bench/gas-localnet.ts`. F1: bind the deposited coin value into the registered
   commitment (deposit-side proof, or store the amount alongside the commitment) and check whether
   `shielded_transfer`'s `cumulative` has the same gap. Both probes in `gas-localnet.ts` must flip
   to "abort" and become regression tests. This is a circuit and/or contract change, so it needs a
   soundness argument, a leakage analysis and negative tests in the same PR.

2. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance from the current baseline) is the highest-leverage next number — it moves prover time
   directly, for every circuit, on every transfer.

3. **Storage layout of the shared `Pool` object.** 2026-11-18: storage is 65% of a transfer's net
   gas, and the ~1,477-byte `Pool` (both VKs inline) is rewritten on every call (~12.2M MIST gross,
   1% non-refundable). Move the VKs into a separate immutable/owned object and measure the
   per-transfer delta with `gas-localnet.ts`. Cheap, and directly moves a number Veil pays.

4. **Batched transfers in one relayer PTB (was: aggregated proof verification).** Re-scoped by the
   2026-11-18 numbers. A single Groth16 verify (~278 units) is already below the 1,000-unit
   per-tx floor, so proof *aggregation* buys ~nothing in computation. The real lever is amortising
   the floor across N transfers in one PTB. Measure per-transfer gas at N = 1, 4, 16, and what a
   shared PTB leaks (it links the N transfers to one relayer submission).

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

13. **Gas on the live testnet/mainnet protocol version.** 2026-11-18 numbers are protocol 124
    (localnet at the Move.lock rev). Needs public-fullnode egress, which was denied from this sandbox.

## Settled / removed

- **On-chain gas per entry point** (was #1): **KEEP 2026-11-18**, now in `BASELINE.md`. The PVK
  caching idea in `verifier.move`'s comment is refuted at protocol 124 (saves 0 MIST per transfer).
- **Fix `circuits`' chained `npm test` hang** (was #12): resolved by #17. On 2026-11-18 the
  chained `npm test` ran all three files to completion (EXIT 0).
