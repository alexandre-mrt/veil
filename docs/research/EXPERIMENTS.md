# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Make the Merkle anonymity set load-bearing (threat-model I7).** *New, 2026-11-11, top
   because it is an unmitigated, high-severity privacy flaw.* `oldCommitment` (transfer) and
   `commitment` (withdraw) are public inputs, and `pool.move` removes them by exact key. So the
   depth-20 Merkle proof hides nothing, and an observer links deposit address → every transfer →
   withdrawal recipient. Experiment: make the spent note private, prevent double-spends by
   nullifier alone, and measure the constraint and gas delta. Needs a soundness argument (nullifier
   uniqueness per note across epochs), a leakage analysis, and negative tests. Design work can
   start without the `sui` CLI; the Move half needs it.

2. **Adopt `circom --O2` for all three circuits.** *New, 2026-11-11, measured.* transfer
   13,611 → 6,384, compliance 12,743 → 5,979, withdraw 3,058 → 1,439 constraints. Each drops one
   power-of-two FFT domain. transfer proving is 22–25% faster in Node, and all 108 real-proof tests
   pass. Remaining before KEEP:
   - change `compile*.sh` and CI;
   - re-measure Node and browser proving for all three on one machine;
   - plan the timelocked on-chain VK rotation;
   - isolate why it is faster (domain vs wires vs non-zeros).
   Cheap, high-confidence, directly moves prover time.

3. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Needs a working `sui` CLI
   (prebuilt binary, or a from-source build budgeted across more than one night) or explicit
   permission to make direct JSON-RPC reads against the already-deployed testnet package
   (`README.md` has real package/pool/config IDs — `suix_queryTransactionBlocks` against a public
   fullnode could recover real historical gas without the CLI at all, if that network call is
   permitted). Blocked three times now (LEDGER 2026-07-22, 2026-11-11). On 2026-11-11, GitHub release downloads and the Sui testnet fullnode returned 403 from the sandbox proxy; `git clone` of `MystenLabs/sui` works (framework rev = tag `testnet-v1.72.1`), but a source build was denied by the session's permission layer. **Needs a human:** allow-list the release download or fullnode in the environment's network policy, or pre-build `sui` in the environment setup script. Until then, do not spend a night on it — worth spending an
   early part of the next run purely on unblocking the toolchain before attempting the measurement.

4. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on the on-chain gas item (#3) existing first (need a real per-verify gas number to know how much this would
   actually save).

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
   port, not a parameter change — so this should wait until the gas and `--O2` items give a clearer picture of
   what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

11. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

12. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

13. **Fix `circuits`' chained `npm test` hang.** Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run: real (non-hash-only) `snarkjs.groth16`
    calls leave the Node process alive after the test file finishes printing results, which stalls
    the `&&`-chained `npm test` script after the first file. Each file passes fine run
    individually. **Done:** fixed in #17 (explicit exit after the last proof). On 2026-11-11 the
    chained `npm test` ran all three files to completion. Kept here only for history.

14. ~~Poseidon2 vs current Poseidon.~~ **Settled: REJECT 2026-11-11.** 0 constraints saved under
    `--O2`; no measurable proving-time change under default flags. A rematch only makes sense with
    a Plonkish backend (fold into the proof-system item), or for native indexer hashing (fold into
    the Merkle-at-scale item).
