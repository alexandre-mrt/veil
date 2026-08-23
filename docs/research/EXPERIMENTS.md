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
   permitted). Blocked three times now (see LEDGER 2026-07-22, 2026-08-23) — 2026-08-23 precisely
   diagnosed it as a sandbox proxy allowlist (403 at the CONNECT layer for both `api.github.com`
   and `fullnode.testnet.sui.io`), not a retriable denial. `git clone` of `github.com` *does* work
   (the proxy special-cases git's smart-HTTP protocol), so a from-source `sui` build is technically
   reachable in a way plain HTTPS downloads aren't — still a multi-night undertaking on its own,
   worth budgeting explicitly rather than attempting as a side effect of another experiment.

2. **Does `--O2` (full R1CS simplification) help the deployed circuits, independent of Poseidon2?**
   2026-08-23 found that `circuits/scripts/compile.sh` (and `compile-withdraw.sh`/
   `compile-compliance.sh`) don't pass `--O2` — circom's default (`--O1`) leaves purely-additive
   linear constraints unswept. For a from-scratch Poseidon2 fork this mattered a lot (see item 3),
   but the underlying question — does `--O2` reduce constraint count / proving time for the
   *current, deployed* `transfer.circom`/`compliance.circom`/`withdraw.circom` as well, and does it
   change the R1CS enough to need a fresh trusted-setup ceremony even without touching the circuit
   source — is unmeasured for the production circuits themselves. Cheap (a compile-flag change, not
   a circuit change), potentially high value (free proving-time reduction for every proof Veil ever
   generates), good candidate for a lighter night.

3. **Close the Poseidon2 gaps found 2026-08-23, then finish the three-circuit picture.**
   `docs/research/2026-08-23-poseidon2-benchmark.md` (PARK verdict) confirmed a real proving-time
   win (−9.7% to −17.1%) for `transfer.circom`/`withdraw.circom` at `--O2`, but: (a) the one hash
   shape needing `t=5` (compliance's `leafHash`) is a net *loss* with the available Poseidon2
   parameter sets (no native `t=5`, forced to `t=8`) — either derive/justify real `t=5`/`t=6` round
   constants, or redesign `leafHash` as two chained `t=4` calls and measure that instead; (b)
   `compliance.circom` itself was never forked end-to-end, so its net direction is still unknown;
   (c) any real adoption needs a fresh Groth16 trusted-setup ceremony and Move/frontend updates,
   not attempted. Depends on item 2's answer first — no point re-deriving the O1-vs-O2 story a
   second time for compliance.circom before knowing whether `--O2` alone is even safe to ship.

4. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
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
    port, not a parameter change — so this should wait until items 1–3 give a clearer picture of
    what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

11. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

12. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

<!-- Former item 13 ("fix circuits' chained npm test hang") was fixed outside this loop —
     PR #17 added an explicit process.exit(0) to all three test runners on 2026-07-28.
     `npm test` in circuits/ now runs all three files chained without stalling (re-confirmed
     2026-08-23). Removed rather than left as a stale entry — see LEDGER 2026-08-23. -->

