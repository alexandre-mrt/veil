# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Transfer linkability: `oldCommitment` is public (2026-11-14 Finding 1).** The transfer and
   withdraw circuits expose the spent commitment, and `pool.move` removes it by key, so a chain
   observer links deposit → every transfer → withdrawal by byte equality. The Merkle membership
   proof (C0) therefore buys no anonymity while costing 69.7% of transfer proving time (measured).
   Design and measure a private-`oldCommitment`, nullifier-only spend (per-commitment nullifier,
   no key removal) with a full double-spend soundness argument and negative tests, or explicitly
   accept linkability and drop C0. Highest priority: it is an unmitigated privacy threat *and* the
   largest prover-time lever found so far.

2. **Adopt circom `-O2` for the production circuits (2026-11-14 Finding 2).** Measured with no
   source change: transfer 693.7 → 520.7 ms (−24.9%), compliance 628.7 → 511.8 ms (−18.6%), zkeys
   −26% / −33%. Needs: `compile*.sh` flag change, all 108 circuit tests + negative tests against
   `-O2` artifacts, browser re-bench (`scripts/bench/browser-latency.mjs`), VK rotation plan
   (timelocked on-chain), Move suite (blocked with item 3). Cheap and measurable in one night.

3. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Needs a working `sui` CLI
   (prebuilt binary, or a from-source build budgeted across more than one night) or explicit
   permission to make direct JSON-RPC reads against the already-deployed testnet package
   (`README.md` has real package/pool/config IDs — `suix_queryTransactionBlocks` against a public
   fullnode could recover real historical gas without the CLI at all, if that network call is
   permitted). Blocked **three** times now (LEDGER 2026-07-22, 2026-11-14). 2026-11-14 found Docker Hub reachable (`mysten/sui-tools:testnet`, `sui` = layer `sha256:f51aad7c…`), but fetching it was denied by the session permission layer; testnet RPC is 403 at the egress proxy. Unblock needs the owner to approve the Docker Hub layer fetch, allowlist `fullnode.testnet.sui.io`, or budget a from-source build — worth spending an
   early part of the next run purely on unblocking the toolchain before attempting the measurement.

4. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 3 (gas) existing first (need a real per-verify gas number to know how much this would
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

10. **rapidsnark vs snarkjs on the same artifacts.** 2026-11-14 showed snarkjs proving time
   tracks R1CS non-zero count, not constraint count. Re-run `scripts/bench/hash-arity/bench.mjs`
   artifacts through rapidsnark to separate prover effects from circuit effects; also the
   realistic server-side/relayer proving number.

11. **4-ary credential tree (PARKED 2026-11-14).** Poseidon2 was REJECTED (−0.93% constraints).
   The 4-ary depth-10 tree cuts non-linear constraints 28% but only helps proving at `-O1`; at
   `-O2` the denser R1CS cancels it under snarkjs. Revisit after item 2 is decided, with a prover
   that is less sensitive to R1CS density (rapidsnark), and for the compliance credential tree (which does hide
   its leaf) at depth > 20. Template, soundness argument and negative tests already in
   `scripts/bench/hash-arity/`.

12. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
   `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
   port, not a parameter change — so this should wait until items 1–3 give a clearer picture of
   what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

13. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

14. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

15. **Fix `circuits`' chained `npm test` hang.** Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run: real (non-hash-only) `snarkjs.groth16`
    calls leave the Node process alive after the test file finishes printing results, which stalls
    the `&&`-chained `npm test` script after the first file. Each file passes fine run
    individually. Fixed upstream in #17 (test runners now exit explicitly); 2026-11-14 ran `npm test` chained, 108/108 green. Kept only as a record.
