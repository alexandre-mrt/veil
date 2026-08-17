# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked a second time on
   2026-08-17 (see LEDGER) — the fullnode JSON-RPC path is confirmed to be a hard sandbox
   network-policy block (`403` on the `CONNECT`, verified via the proxy's own status endpoint), not
   a transient or permission-layer issue. But 2026-08-17 also found the from-source path is more
   viable than 2026-07-22 assumed: `git clone` + `cargo build` for the `sui` CLI both work in this
   sandbox (only raw `curl` to `github.com`/`crates.io` is blocked), and a background build reached
   ~1,140 compiled crates in 45 minutes without finishing. **Procedural fix for the next run that
   picks this up:** `git clone --depth 1 --branch testnet https://github.com/MystenLabs/sui.git`
   and `nohup cargo build --release --bin sui -p sui &> sui-build.log &` in the *first five minutes*
   of the session, then do that night's actual measured experiment while it compiles unattended, and
   check back at the end. If it finishes, spend the remainder of the budget on the gas measurement
   (`sui client call` / a script against the deployed package IDs in `README.md`); if not, let it
   keep running past the session boundary (it won't survive the container regardless) and re-rank
   with the fresh percent-complete evidence, same as tonight.

2. **Full `compliance.circom` Poseidon/scaffolding reconciliation.** Cheap, ranked ahead of the
   Poseidon2 port below because 2026-08-17 only established `compliance.circom`'s shape by
   inspection (81.6% of its 12,743 constraints look like `MerkleProof(20)`, un-reconciled). Extend
   `scripts/bench/poseidon-constraint-breakdown.mjs` with a `Poseidon(5)` case (the credential leaf
   hash) and a `compliance`-shaped scaffolding circuit (`GreaterEqThan(64)`, `GreaterEqThan(8)`,
   `Num2Bits(64)`x3, `Num2Bits(8)`x2) and confirm the same exact-delta reconciliation
   `transfer.circom` got tonight. Should take under an hour; a good "finish the methodology" pick
   for a lighter night.

3. **Poseidon2 for the Merkle chain specifically (not the whole circuit).** 2026-08-17's constraint
   breakdown (`docs/research/2026-08-17-poseidon-merkle-constraint-breakdown.md`) found the 20-level
   `MerkleProof` Poseidon(2) chain is 76.4% of `transfer.circom`'s constraints and 81.6% of
   `compliance.circom`'s — an order of magnitude more than the three domain-tagged
   commitment/nullifier/amount-hash `Poseidon(4)`/`Poseidon(3)` calls combined (20.7%). That
   *narrows* this experiment from "swap Poseidon for Poseidon2 everywhere" to "swap only the
   Merkle-chain hash" — a smaller, more defensible change. Still gated on finding or vendoring a
   trustworthy circom Poseidon2 implementation with published/checkable round constants and test
   vectors first (`circomlib` 2.0.5 ships none, and hand-deriving them was explicitly rejected as
   too risky for a one-night change on 2026-08-17 — this applies with equal force here). Do not
   attempt a hand-rolled permutation; find a reference implementation with test vectors or don't do
   this one.

5. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

6. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). Now also directly informed by
   the 2026-08-17 finding that Merkle-path Poseidon calls dominate constraint count — depth changes
   here have an even bigger prover-time effect than previously known.

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
