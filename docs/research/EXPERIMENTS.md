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
   directly, for every circuit, on every transfer. Also now has a real on-chain gas baseline
   (2026-09-18) to check against: does a smaller proof/fewer public inputs move `shielded_transfer`'s
   storage-dominated gas cost at all, or is the storage floor set by the nullifier/commitment
   dynamic fields regardless of circuit size?

2. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** No longer blocked —
   2026-09-18 measured a real per-`shielded_transfer` cost (2,872,944 MIST net, of which the fixed
   1,000,000 MIST computation floor is unaffected by proof count — see that report's gas-bucketing
   finding). That finding actually *undercuts* this experiment's premise: if `groth16::verify` is
   already computation-gas-free, batching N verifications into 1 can only save the *storage* that N
   separate calls would each pay (dynamic fields, event data), not computation — worth confirming
   directly before investing in the aggregation circuitry.

3. **Sui's computation-gas bucketing.** New item, surfaced by 2026-09-18: every one of 14 measured
   entry points — including three real Groth16 pairing verifications — landed in the exact same
   1,000-computation-unit minimum bucket. Is there *anything* in Veil's contracts that exceeds it,
   and if not, is that a standing property worth documenting rather than re-discovering by accident?
   Cheap to check: call each entry point in a loop inside one PTB and see if computation cost ever
   moves, or deliberately construct a compute-heavy Move call (e.g. a large loop) to find the next
   bucket boundary.

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

13. **Fix `frontend`'s broken `lint` script.** Not a research experiment — a tooling papercut
    surfaced 2026-09-18: `bunx biome check .` (both locally and in `.github/workflows/ci.yml`'s
    `frontend-tests` job) resolves to an unrelated, unscoped npm package also named `biome`
    (`@biomejs/biome` is never declared as a dependency), which silently does nothing — so no PR has
    ever actually been linted. The real package also needs `biome.json` migrated from its current
    1.x-schema keys (`files.ignore`) to 2.x. Low priority; fold into a future night already touching
    `frontend/`.
