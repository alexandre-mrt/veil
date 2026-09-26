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
   permitted). Blocked three times now for the same class of reason (see LEDGER 2026-07-22,
   2026-09-26 — GitHub releases and crates.io both still 403 through the proxy). Re-attempting a
   fourth time unmodified is unlikely to help; worth trying a genuinely different unblock path
   next time (e.g. asking for the JSON-RPC permission explicitly rather than treating the earlier
   denial as final) rather than re-running the same `sui`-CLI checks.

2. **Wire the Poseidon2 Merkle-path swap into production.** 2026-09-26 built and measured
   `transfer_poseidon2.circom` (research variant): -540 non-linear constraints (-8.3%), -660 total
   (-4.85%) vs. `transfer.circom`, fully verified against a JS reference (11/11 tests including 3
   negative tests). Not yet wired into `pool.move` — needs a real (multi-party) trusted setup for
   the new circuit, a `transfer_vk` migration path, and a plan for the already-deployed testnet
   pool. This is now an integration task, not a measurement one.

3. **The other three named Poseidon instances (commitments, nullifier, txAmountHash) — Poseidon2
   at t=4/t=5.** 2026-09-26 scoped its Poseidon2 experiment to the Merkle path only (t=2
   compression, established zk-kit convention). `@taceo/circom-lib` supports Poseidon2 at t=4
   directly; t=5 (needed for the two 4-input commitment/nullifier hashes) is unsupported by that
   library and would need either padding to t=8 or a different arity choice — needs its own design
   pass before it's a same-night-doable experiment like the Merkle path was. Compliance.circom
   likely has a similar Merkle-dominated profile worth checking too (12,743 total / 6,057
   non-linear per the 2026-07-22 baseline — not yet broken down by instance).

4. **Independent second Poseidon2 implementation cross-check.** 2026-09-26's correctness tests
   compare `@taceo/circom-lib`'s circom template only against `@taceo/poseidon2`'s JS permutation
   — same publisher, same claimed parameter provenance (HorizenLabs script, Rust crate parity). A
   from-scratch derivation from the HorizenLabs sage script, or a comparison against a genuinely
   independent implementation using the *same* parameter set, would close that residual assumption.
   Cheap (a few hours), good fit for a lighter night.

5. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

6. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). Can now reuse the 2026-09-26
   Poseidon2 per-level constraint cost (219 vs 246 non-linear) instead of re-deriving it.

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
    port, not a parameter change — so this should wait until items 1–3 give a clearer picture of
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
