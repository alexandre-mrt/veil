# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Fix the dead `ptau` URL (CI + compile scripts).** Found 2026-10-21: `storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau` returns 403, so `.github/workflows/ci.yml:59`, `circuits/scripts/compile*.sh`, `ceremony.sh` and `scripts/bench/prove-latency.mjs` cannot fetch their powers of tau. Verified workaround: PSE `ppot_0080_15.ptau` (`pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/`) + `snarkjs powersoftau prepare phase2` (~8 min; do it once and cache in CI). Not research — a one-hour tooling night, but CI's circuit job is red-as-written until it lands.

2. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance from the current baseline) is the highest-leverage next number — it moves prover time
   directly, for every circuit, on every transfer.

3. **Per-transfer storage footprint (new, from the 2026-10-21 gas run).** Computation is pinned at the minimum bucket, so net storage (2.9M MIST/transfer, 5.3M compliant, ~3.2M/deposit) is the number Veil pays. Isolate how much is the `Pool` object rewrite vs. the permanent nullifier/commitment dynamic fields vs. the `ComplianceConfig` rewrite, then test whether a leaner layout (e.g. per-epoch nullifier objects, smaller `Pool` by moving VKs out) moves it. Uses `scripts/bench/gas.ts` directly.

4. **Shared-object contention on the `Pool`.** Every transfer mutates one shared object; sustainable tx/s under concurrent `shielded_transfer` is unmeasured. Extend `gas.ts` into a concurrent load run (needs many pre-proved witnesses + distinct commitments). Moves the throughput ceiling that anonymity-set growth (item below) depends on.

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

10. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** *Demoted 2026-10-21*: the gas run shows Groth16 verification lands in the minimum compute bucket (1M MIST) even with two verifies per tx, so batching saves ≈0 computation gas. Only worth revisiting if validator-side pricing of the native `groth16` verify changes, or for a non-gas reason (throughput, proof-size/bandwidth). Rematch condition recorded here, not silently dropped.

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

14. **Fix `circuits`' chained `npm test` hang.** Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run: real (non-hash-only) `snarkjs.groth16`
    calls leave the Node process alive after the test file finishes printing results, which stalls
    the `&&`-chained `npm test` script after the first file. Each file passes fine run
    individually. Low priority; fold into whichever future night touches `circuits/test/`.
