# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Poseidon2 at arity 2, isolated and measured, targeting the Merkle hasher specifically.**
   2026-08-06's gadget decomposition (`BASELINE.md`, full writeup
   [`2026-08-06-poseidon-constraint-decomposition.md`](2026-08-06-poseidon-constraint-decomposition.md))
   found the informal claim below (four domain-tagged Poseidon calls dominate) is **only true for
   `withdraw.circom`**. For `transfer.circom` and `compliance.circom`, the depth-20
   `MerkleProof` — 20 chained `Poseidon(2)` calls — is 76–81% of all non-linear constraints, ~4x
   the four top-level calls combined (14–18%). Re-ranked to #1: build an isolated Poseidon2
   arity-2 gadget under `circuits/bench/` (same harness, `scripts/bench/gadget-constraints.sh`),
   measure it standalone against the existing 243-non-linear-constraint `Poseidon(2)` baseline,
   *before* committing to any production circuit rewrite. 246 non-linear constraints/Merkle-level
   (243 hash + 3 selector) is the number this experiment moves.

2. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked a third time on
   2026-08-06, this time with definitive evidence it's a network-policy decision, not a toolchain
   gap: that session's egress proxy returned explicit `403` policy denials for `github.com`,
   `crates.io`, *and* `fullnode.testnet.sui.io` (`$HTTPS_PROXY/__agentproxy/status` — "gateway
   answered 403 to CONNECT (policy denial)"; the proxy's own docs say do not retry or route around
   a 403, report it instead). **Do not spend another night's early effort re-searching for a
   toolchain workaround** — the fix is an infrastructure change: add `fullnode.testnet.sui.io` to
   this session type's egress allowlist (a read-only JSON-RPC call against a public testnet
   fullnode, `suix_queryTransactionBlocks`, is low-risk to allowlist), or provide a prebuilt `sui`
   CLI binary in the environment image. Re-attempt once either exists; until then this item is
   blocked on someone outside the loop, not on tonight's agent.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 2 existing first (need a real per-verify gas number to know how much this would
   actually save).

4. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). The proving-time side of this
   trade-off no longer needs a fresh measurement for small depth changes: 2026-08-06 established
   246 non-linear constraints per Merkle level (243 hash + 3 selector), so e.g. depth 20 → 26 for a
   larger anonymity set is +1,476 non-linear constraints, computable directly. Batch-insertion cost
   and indexer throughput at 10^5–10^7 commitments remain genuinely unmeasured.

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

12. **Check whether `scripts/test-compliance-utils.ts`'s slow depth-20 test shares a cause with the
    now-fixed `circuits` test hang.** `circuits`' chained `npm test` hang (real `snarkjs.groth16`
    calls leaving the Node process alive after printing results — noticed 2026-07-22) was fixed on
    `main` between nights, outside this loop: PR #17 (`f942fca`) added an explicit
    `process.exit(0)` to all three `circuits/test/*.test.mjs` files. That part of this item is
    done. A related-looking but distinct symptom showed up 2026-08-06 in a different package:
    `scripts/test-compliance-utils.ts`'s depth-20 real-Poseidon `getMerkleProof` verification ran
    for several minutes without completing (killed, not diagnosed) — this one touches no
    `snarkjs.groth16` call at all, so PR #17's fix can't apply; it's more likely genuine
    2^20-scale-real-Poseidon-in-pure-JS slowness (`circomlibjs`), which would matter directly for
    item 4's indexer-throughput question if so. Worth a real diagnosis, not assumed to be the same
    bug. Low priority; fold into whichever future night touches `scripts/src/`.
