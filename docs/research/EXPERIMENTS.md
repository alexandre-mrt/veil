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
   permitted). Blocked twice now for different reasons (see LEDGER 2026-07-22) and reconfirmed a
   third time 2026-08-31 (JSON-RPC to a public testnet fullnode: `403`; `cargo`/crates.io crate
   content for a from-source build: `403` — only crates.io index *metadata* and `api.github.com` are
   reachable, though git-protocol clones of GitHub repos do work). This now looks like a stable
   property of the current network policy, not something worth re-attempting per session — worth
   escalating to whoever configures this environment's network policy rather than re-testing it on
   every run.

2. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance from the current baseline) is the highest-leverage next number — it moves prover time
   directly, for every circuit, on every transfer.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

4. **Merkle accumulator at scale (10^5–10^7 commitments) — on-chain half remaining.** The
   off-chain build-cost half is done (2026-08-31, KEEP): `compliance-utils.ts` and
   `frontend/lib/merkle-tree.ts` build/prove the depth-20 tree in `O(n + depth)` Poseidon calls now,
   not `O(2^depth)`, and depth-24 (~16.8M capacity) builds in seconds, not the ~27 minutes a naive
   rebuild would need there. What's still open: raising the *on-chain* depth itself, which is a
   circuit parameter (`MerkleProof(depth)` in `templates/merkle_proof.circom`) — needs a constraint-
   count delta for `MerkleProof(24)` vs `MerkleProof(20)`, a new trusted-setup ceremony, and the real
   anonymity-set-vs-proving-time tradeoff curve. Still directly relevant to `docs/threat-model.md`
   RR5 (a bigger anonymity set is the main lever available without redesigning the deposit flow) —
   this is now purely a "spend the ceremony + circuit-change budget" question, not an "is this even
   buildable off-chain" one.

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

~~12. Fix `circuits`' chained `npm test` hang.~~ **Done**, outside this loop — PRs #16/#17 added an
    explicit `process.exit(0)` to each test runner after the CI job that spotted the same symptom
    (it was timing out at 6h). Confirmed fixed 2026-08-31: the three-file `&&` chain now completes
    cleanly in one run.
