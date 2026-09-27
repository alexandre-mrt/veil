# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Needs a working `sui` CLI
   (prebuilt binary, or a from-source build budgeted across more than one night) or explicit
   permission to make direct JSON-RPC reads against the already-deployed testnet package
   (`README.md` has real package/pool/config IDs — `suix_queryTransactionBlocks` against a public
   fullnode could recover real historical gas without the CLI at all, if that network call is
   permitted). Blocked twice now for different reasons (see LEDGER 2026-07-22) — worth spending an
   early part of the next run purely on unblocking the toolchain before attempting the measurement.

2. **Merkle-depth-vs-anonymity-set trade-off (was item 4 — promoted 2026-09-27).** The 2026-09-27
   constraint-attribution experiment (`docs/research/2026-09-27-poseidon-constraint-attribution.md`)
   measured that the depth-20 Merkle membership proof, not the named domain-tagged Poseidon calls,
   is responsible for 76.0% of `transfer.circom`'s and 81.2% of `compliance.circom`'s non-linear
   constraints — an exact, reconciled per-level cost of 246 non-linear constraints per tree level,
   architecture-fixed regardless of depth. That makes Merkle depth the highest-leverage lever on
   prover time for those two circuits, ahead of a Poseidon2 swap of the named hashes (item 3 below).
   Extends into the full item 4 scope from before (batch insertion cost at 10^5–10^7 commitments,
   indexer throughput) but now has a real per-level number to compute against instead of a guess —
   e.g. depth 20→32 costs a computed +2,952 non-linear constraints to `transfer.circom` alone.
   Directly relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger
   anonymity set is the main lever available without redesigning the deposit flow).

3. **Poseidon2 vs current Poseidon — re-targeted 2026-09-27.** The 2026-09-27 attribution
   experiment found the "four Poseidon instances dominate" framing this item used to rank on was
   incomplete: for `transfer.circom`/`compliance.circom` the named domain-tagged calls are only
   18.0%/14.1% of non-linear constraints, while the Merkle path's 20x `Poseidon(2)` calls (not
   counted among the "four") are 76.0%/81.2%. A Poseidon2 experiment should target the arity-2
   permutation first — that's where the constraint-count leverage actually is — not the named
   commitment/nullifier/amount hashes. (`withdraw.circom` has no Merkle path, so there the named
   calls genuinely are the dominant cost at 78.0% — Poseidon2 still matters for that circuit
   specifically.) No Poseidon2 circuit was built or measured tonight; this is still a real circuit
   change requiring correct round constants/matrices (no independently-fetchable reference test
   vectors given this sandbox's GitHub block) plus the soundness argument, leakage analysis, and
   negative test any circuit change needs.

4. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

5. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented.

6. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.
   A t-of-n threshold scheme (or even measuring the cost of a naive N-of-N re-encryption) changes
   the trust model for compliance data meaningfully and is a natural fit for the "confidential
   payroll with a t-of-n auditor board" use case named in the 2026-07-22 report.

7. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock). An
   RSA or Merkle-based revocation accumulator could make single-credential revocation cheaper
   without a full root rebuild — worth a real cost comparison, not just a design note.

8. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
   (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
   profile (`page.emulate(...)`) and compare against the desktop-headless numbers already in
   `BASELINE.md`. Good "spend an hour, get a real number" candidate for a lighter night.

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

12. **Fix `circuits`' chained `npm test` hang.** Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run: real (non-hash-only) `snarkjs.groth16`
    calls leave the Node process alive after the test file finishes printing results, which stalls
    the `&&`-chained `npm test` script after the first file. Each file passes fine run
    individually. Low priority; fold into whichever future night touches `circuits/test/`.
