# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

*Re-ranked 2026-10-10 after the on-chain gas baseline (see `LEDGER.md`): gas is storage-bound and
verification sits under Sui's 1,000-unit computation floor, so batching-for-gas is demoted and
the measurable, Veil-paid numbers left are prover time, anonymity-set size, Pool contention.*

1. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Unchanged at the top: prover
   time is the one cost the 2026-07-22 and 2026-10-10 baselines show Veil actually pays at scale
   (≈ 750 ms Node / ≈ 1.2 s browser per transfer; on-chain verification is free at the margin).
   Four Poseidon instances dominate `transfer.circom`'s and `compliance.circom`'s non-linear
   constraints (6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance from the current baseline) moves prover time directly, for every circuit.

2. **Pool shared-object contention and throughput under concurrent transfers.** *New (2026-10-10).*
   Every transfer touches the one shared `Pool`. `scripts/bench/gas-localnet.mjs` already drives
   real proofs on a local net; extend it with `--committee-size 4`, N concurrent senders, and
   measure transfers/s, latency tail, and the effect of invalid-proof spam (priced at only
   ≈ 1.1M MIST per rejected attempt) on honest-transfer latency. Direct input to threat-model
   DoS entries.

3. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5. *New constraint from 2026-10-10:* every Pool touch
   rewrites the whole object and pays a 1% non-refundable storage fee, so any in-object frontier
   raises the floor for every call — measure it with `gas-localnet.mjs`.

4. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign.

5. **Mobile WASM proving latency.** Cheap extension of `scripts/bench/browser-latency.mjs` (add a
   mobile Chromium device-emulation profile via `page.emulate(...)`). Good "spend an hour, get a
   real number" candidate for a lighter night. Promoted: with on-chain cost bounded, client prove
   time is the user-visible latency.

6. **Storage-layout gas: cheaper `Pool` and dynamic-field layout.** *New (2026-10-10).* Transfers
   cost ≈ 1.88M net storage MIST (new nullifier + commitment fields, old commitment removed);
   the `Pool` object is ≈ 9.7M MIST per rewrite. Test: VKs in separate objects/dynamic fields,
   nullifier+commitment packing — measured with `gas-localnet.mjs`, with a leakage check for
   anything that changes what a chain observer sees.

7. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) assume one auditor keypair. A t-of-n
   scheme changes the trust model for compliance data and fits the "confidential payroll with a
   t-of-n auditor board" use case.

8. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Revoking a KYC
   credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock). An RSA
   or Merkle-based revocation accumulator could make single-credential revocation cheaper.

9. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** *Demoted from #3
   (2026-10-10).* The premise was a per-verify gas saving; measured, a verification is
   ≈ 312 computation units (≈ 0.0003 SUI at RGP 1,000) and a single call is under the
   1,000-unit floor, and aggregation does not touch the dominant per-transfer storage. Revisit only
   if live testnet/mainnet gas pricing (item 12) shows a much higher compute price, or for
   throughput rather than gas reasons.

10. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
    `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
    port — so wait until items 1–3 clarify what is worth optimizing.

11. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely design-only, UNMEASURED-labelled.

12. **Live testnet/mainnet gas cross-check.** *New (2026-10-10).* The 2026-10-10 numbers are from a
    local `sui 1.81.1` genesis (RGP 1,000). Re-run `gas-localnet.mjs` (or read the deployed
    package's historical transactions, `README.md` has the IDs) against a live network when
    outbound RPC to a public fullnode is permitted; confirm the 1,000-unit floor and the
    ≈ 312-unit marginal proof cost hold on the current protocol version.

13. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — requests/sec before
    rate-limiting kicks in, timing side-channels that could deanonymize sender-relayer pairs
    under concurrent load.

14. **Tooling: snarkjs lingering-worker hang in `scripts/bench`.** `prove-latency.mjs` still does
    not exit after printing its table (`gas-localnet.mjs` calls `process.exit(0)` itself). The
    `circuits` chained `npm test` hang that this item originally tracked was fixed upstream in #17
    (re-verified 2026-10-10: `npm test` exit 0, 47.7 s). Trivial; fold into the next bench change.
