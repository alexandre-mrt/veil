# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Fix E7: bind `zk_withdraw`'s `recipient` argument to `recipientHash`.** Found and
   demonstrated on-chain 2026-11-23: a withdraw proof generated for address A is accepted with
   `recipient = B`, and B gets the coin. `docs/threat-model.md` E7 now says *Open*. Fix: recompute
   `Poseidon(8, address_as_u256 mod r)` with `sui::poseidon::poseidon_bn254` in `zk_withdraw` and
   compare it to public-input bytes 96..128. Same night: (a) confirm `poseidon_bn254` matches
   circomlib Poseidon on a test vector, (b) fix one address→field convention in the circuit tests,
   the harness and the client, (c) a Move test with a real proof for the honest and substituted
   cases, (d) **measure the on-chain Poseidon's gas** with `scripts/bench/run-gas-local.sh` (whose
   E7 probe must flip from `success` to an abort). Highest priority: it's an open fund-theft path.

2. **Compliance proof ↔ transfer binding.** `compliant_transfer` never checks compliance public
   input `contextId` (bytes 64..96) against the transfer it accompanies. `contextId =
   Poseidon(6, transferNullifier, userSecret)` can't be recomputed on-chain, so nothing ties a
   compliance proof to *this* transfer's nullifier or this user. A KYC'd user might be able to mint
   compliance proofs for arbitrary contexts and lend them to non-KYC users. Needs an adversarial
   witness test first (is it exploitable given the circuit's constraints?), then a design: for
   example, expose `transferNullifier` as a shared public input across both proofs.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   2026-11-23 numbers change the framing. On gas model v15 a single verification costs about
   184–268 computation units and every Veil transaction sits under the 1,000-unit floor, so
   verification is *not* the bill; storage is. The cheap first step needs **no contract change**:
   a relayer puts N `shielded_transfer` calls in one PTB, sharing one computation floor and one
   Pool rewrite. Measure net MIST per transfer for N = 1..8, and what co-batching leaks
   (transfers in one digest are linkable). Real proof aggregation (SnarkPack and similar) only
   pays once N × ~268 units clearly exceeds the floor.

4. **Move the VKs out of the shared `Pool`.** Each Pool-touching tx rewrites the whole object (VKs
   inline). Gross storage is about 12M MIST to front, 99% rebated. Moving VKs (and pending VKs) into
   a separate immutable object would shrink what senders and relayers have to front per transaction.
   Measure with `run-gas-local.sh` before/after.

5. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance from the current baseline) is the highest-leverage next number — it moves prover time
   directly, for every circuit, on every transfer.

6. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow).

7. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented.

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

14. **Re-measure gas on testnet's live protocol version.** The 2026-11-23 numbers come from a
   local network at protocol 142 (gas model v15). Older gas models bucket computation more
   coarsely. Needs network access to a Sui fullnode (403 from the sandbox on 2026-11-23).

Settled / removed:
- *On-chain gas per entry point* (was #1): measured 2026-11-23 (see LEDGER), KEEP.
- *Prepared-VK caching for single-proof txs*: REJECTED 2026-11-23. Saves ~83 units per verify but 0
  MIST per tx under the 1,000-unit floor. Revisit only inside batching (#3).
- *Fix `circuits`' chained `npm test` hang* (was #12): fixed by #17. Chained `npm test` ran to
  completion 2026-11-23.
