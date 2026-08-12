# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance from the current baseline) is the highest-leverage next number — it moves prover time
   directly, for every circuit, on every transfer.

2. **Batched/aggregated proof verification (N transfers → 1 on-chain verify) — hypothesis reframed
   2026-08-12.** Originally ranked on the assumption that verification cost is roughly linear in
   proof count, so batching would save proportional gas. The 2026-08-12 on-chain gas measurement
   found Sui's computation cost is *bucketed*, not metered continuously: every entry point
   measured — including `compliant_transfer`'s two independent `sui::groth16` verifications —
   landed in the same cheapest 1,000,000-MIST computation bucket as a single boolean admin flip.
   If verification is already in the floor bucket, batching N verifications into one doesn't save
   computation MIST the way a linear model predicts; any saving would have to come from
   amortizing fixed per-transaction overhead or from storage, not from proving cost itself. Before
   building anything, the next run on this item should first find where the computation bucket
   *boundary* actually is (how many verifications in one transaction it takes to spill into the
   next bucket) — that number determines whether this experiment is worth pursuing at all.

3. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). Now has a real per-write
   storage-cost data point to build from: 2026-08-12 measured `pool::update_commitment_root`
   (a single 32-byte root swap) at 11,970,000 storage MIST net 1,360,468 after rebate, and
   `deposit_and_register` (one dynamic-field insert) at 14,075,200 storage MIST net 3,172,232 —
   worth correlating against exact bytes written before extrapolating to a real batch-insertion
   cost model.

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

8. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
   `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
   port, not a parameter change — so this should wait until items 1–3 give a clearer picture of
   what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

9. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
   computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
   experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
   migration path would cost, not a benchmark.

10. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

11. **Real testnet/mainnet reference gas price vs. the 2026-08-12 local-network default.** That
    run used `sui start`'s development default (1,000 MIST); if real validators vote a materially
    different price, every MIST figure in `BASELINE.md`'s gas table scales linearly, though the
    computation/storage ratio finding does not. Blocked on the same network-policy wall as
    everything else needing `fullnode.*.sui.io` — worth re-attempting only if that policy changes,
    not by re-trying the same denied path.

12. **Fix `circuits`' chained `npm test` hang.** Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run: real (non-hash-only) `snarkjs.groth16`
    calls leave the Node process alive after the test file finishes printing results, which stalls
    the `&&`-chained `npm test` script after the first file. Each file passes fine run
    individually (and the same fix — an explicit `process.exit(0)` — was applied in
    `scripts/bench/generate-proofs.mjs` on 2026-08-12 for the identical symptom). Low priority;
    fold into whichever future night touches `circuits/test/`.

13. **`sui move test` env resolution friction.** Noticed 2026-08-12: after `sui client switch --env
    local` (needed for the gas benchmark), `sui move test` fails to resolve `Move.toml`'s
    dependencies (`Could not determine the correct dependencies to use for 'local'`) because
    `Move.toml` has no `[environments]` entry for an ad-hoc localnet, and unlike `test-publish`,
    `sui move test` has no `--build-env` override. Workaround used: switch back to `testnet` before
    running Move tests. Tooling papercut, not urgent — fold into a future night that touches
    `Move.toml`.
