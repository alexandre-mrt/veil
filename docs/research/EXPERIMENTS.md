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
   permitted). Blocked three times now (see LEDGER 2026-07-22, 2026-09-23) — the 2026-09-23 attempt
   got a firmer signal than before: `fullnode.testnet.sui.io` returns an explicit egress-proxy `403`
   (organization policy, not a one-off tool denial). Unblocking this needs either `api.github.com`/
   release-download access for the `sui` CLI, or an explicit allowance for that one RPC host — both
   are outside what this loop can grant itself. Keep re-checking, but stop re-attempting the exact
   same two paths each night; note explicitly if the access picture hasn't changed rather than
   re-deriving the same conclusion at length.

2. **Port Poseidon2 and measure the real constraint/proving-time delta.** 2026-09-23 quantified the
   ceiling with an exact, verified measurement: Poseidon (including the depth-20 Merkle check, which
   is pure Poseidon(2)) is 94.0% of `transfer.circom`'s, 95.3% of `compliance.circom`'s, and 78.0% of
   `withdraw.circom`'s non-linear constraints (`scripts/bench/poseidon-cost/`, predicted-vs-actual
   matched exactly). That's the real leverage number the original item 2 was estimating — now this
   is squarely a "go implement it" item, not a "figure out if it's worth it" item. The hard
   requirement, unchanged from 2026-09-23's finding: do **not** hand-derive or blindly pull an
   unverified circom Poseidon2 implementation from a guessed GitHub URL — that's a supply-chain risk
   for a protocol's hash function. Either get `api.github.com` code-search access to find a citable,
   reviewable implementation, get explicit permission to trust a specific named repo, or hand-derive
   round constants from the published paper and cross-check the output against at least one
   independent reference (`poseidon2`, `@zkpassport/poseidon2`, or `@taceo/poseidon2` on npm — all
   reachable) on known test vectors before it goes near a circuit. This is a circuit change, so it
   needs the full soundness-argument + leakage-analysis + negative-test treatment when it lands.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

4. **Merkle accumulator at scale (10^5–10^7 commitments).** 2026-09-23 answered one slice of this for
   free while measuring Poseidon's share: non-linear constraint cost scales exactly linearly with
   Merkle depth, 246.0 constraints/level, confirmed at two depth deltas (`scripts/bench/poseidon-cost/`).
   Still open: whether that translates linearly into *proving time* (constraint count and proving
   time were shown not to scale identically in the 2026-07-22 baseline — needs the ptau file, which
   is currently `403`-blocked the same as item 1's RPC fallback), batch insertion cost, and indexer
   throughput for reconstructing the tree client-side. Directly relevant to `docs/threat-model.md`
   RR5 (deposit-commitment linkability — a bigger anonymity set is the main lever available without
   redesigning the deposit flow).

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

13. **`scripts/src/test-compliance-utils.ts` takes ~5 minutes to run 67 tests.** Noticed 2026-09-23
    — every other JS/TS test suite in the repo finishes in seconds; this one visibly pegs one CPU
    core the whole time (consistent with repeatedly building depth-20 Merkle trees rather than
    reusing one across cases). Passes (67/67), just slow. Low priority tooling papercut, same bucket
    as item 12; fold into whichever future night touches `scripts/src/compliance-utils.ts` or its
    tests.
