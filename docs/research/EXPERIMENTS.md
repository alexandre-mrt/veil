# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. **BLOCKED a third time
   2026-08-11** (see LEDGER row and the item-#1 section of
   [`2026-08-11-poseidon2-vs-poseidon.md`](2026-08-11-poseidon2-vs-poseidon.md)): JSON-RPC to
   public fullnodes AND GitHub release-binary downloads are both confirmed egress-policy 403s in
   this environment — those two paths are dead until the policy changes, stop re-probing them.
   New 2026-08-11 finding: git-protocol access to `MystenLabs/sui` *works*, so the credible
   remaining paths are (a) a from-source `sui` build budgeted across multiple nights (start it
   early, let it run in the background, checkpoint the target dir), or (b) an environment/policy
   change (allowlist a Sui fullnode, or provide a `sui` binary in the image). Stays #1 because
   items 3 and 4 still need a real per-verify gas number as their own baseline.

2. **Griffin (or other low-degree hash) vs Poseidon on the Merkle path.** Successor to the settled
   Poseidon2 question (REJECT, 2026-08-11): the Merkle path is a measured 76–81% of
   transfer/compliance non-linear constraints, so per-level hash cost is still the biggest single
   lever. The same vendored repo (`scripts/bench/poseidon2/vendor/` source: bkomuves/hash-circuits)
   ships a Griffin t=3 BN254 permutation whose design targets exactly the R1CS cost model Groth16
   pays for. Reuse tonight's rig (`constraint-costs.mjs`, `merkle-prove-latency.mjs`) as-is; any
   KEEP must also weigh Griffin's younger cryptanalysis record explicitly, not just the number.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

4. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). New input from 2026-08-11:
   per-instance costs are now measured (Poseidon(2) 243 / Poseidon(4) 300 non-linear), so the
   arity trade-off is precisely computable before building — e.g. depth-10 arity-4 ≈ 3,000
   non-linear in hashes vs today's 4,920 Merkle total for the same 2^20 set (wider muxes extra).

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

12. ~~**Fix `circuits`' chained `npm test` hang.**~~ **RESOLVED** outside the loop by PR #17
    (`fix(circuits): exit test runners explicitly after the last proof`). Confirmed 2026-08-11:
    the chained `cd circuits && npm test` now runs all three files to completion (108/108).
