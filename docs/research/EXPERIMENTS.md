# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Merkle accumulator at scale (10^5–10^7 commitments).** Promoted to top of the queue
   2026-08-20: the 2026-08-20 constraint-attribution experiment measured the Merkle membership
   proof at exactly 243 non-linear constraints per level (`Poseidon(2)`, `MerkleProof(20)` =
   4,920 non-linear / 20 levels), and it's 75–80% of `transfer.circom`'s and `compliance.circom`'s
   non-linear constraint count — so depth-vs-anonymity-set is now a *quantified* trade-off, not
   just a named one, and this is the item that spends that number. Covers: batch insertion cost,
   depth-20 vs. a deeper tree (each extra level costs exactly 243 non-linear constraints, from
   tonight's measurement), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability). Also the right place to
   measure Poseidon2's *actual* efficiency claim (see item 9) — native hash throughput in an
   off-chain indexer rebuilding a large tree, as opposed to R1CS constraint count, which 2026-08-20
   ruled out as a target.

2. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis, and the dependency for item
   3 below. Re-attempted 2026-08-20 and reclassified: every path this session found to a `sui`
   binary or a testnet RPC — `fullnode.testnet.sui.io`, `github.com` releases, `crates.io` (API and
   binary CDN) — returns `403` from the sandbox's egress proxy, confirmed by the proxy's own
   diagnostics as an **organization policy denial**, not a transient failure or a budget decision.
   Do not spend another night re-attempting the network path alone — it will not change without
   either a policy exception for one of those hosts or a `sui` binary preinstalled in the sandbox
   image. Worth revisiting only if the sandbox environment changes, or if someone can grant one of
   those exceptions ahead of a run.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Still depends on item 2 (a real per-verify gas number to know how much this would actually
   save) — blocked transitively on the same network wall until item 2 unblocks.

4. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented. Needs no blocked toolchain — a good
   candidate if item 1 turns out to need more than one night.

5. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.
   A t-of-n threshold scheme (or even measuring the cost of a naive N-of-N re-encryption) changes
   the trust model for compliance data meaningfully and is a natural fit for the "confidential
   payroll with a t-of-n auditor board" use case named in the 2026-07-22 report.

6. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock). An
   RSA or Merkle-based revocation accumulator could make single-credential revocation cheaper
   without a full root rebuild — worth a real cost comparison, not just a design note.

7. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
   (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
   profile (`page.emulate(...)`) and compare against the desktop-headless numbers already in
   `BASELINE.md`. Good "spend an hour, get a real number" candidate for a lighter night. Needs no
   blocked toolchain.

8. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
   `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
   port, not a parameter change — so this should wait until items 1–2 (now blocked) or item 4 give a
   clearer picture of what's actually worth optimizing before committing a multi-night effort to a
   proof-system swap.

9. **Poseidon2 — native hashing throughput, not R1CS constraints.** Re-scoped 2026-08-20: the
   original framing ("swap Poseidon for Poseidon2 to cut circuit constraints") is **REJECT**ed —
   see the 2026-08-20 report — because R1CS doesn't charge for the linear/MDS layer Poseidon2 makes
   cheaper, only for the S-box, which is unchanged. The real claim left to test is native (off-circuit)
   hashing speed in a large-scale indexer (item 1's Merkle-at-scale experiment). Blocked on the same
   network wall as item 2: every Poseidon2 reference implementation found lives behind `github.com`,
   and fabricating round constants/matrices without one to verify against is not a measurement.
   Revisit once item 2's network block lifts, folded into item 1's scope rather than run standalone.

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
