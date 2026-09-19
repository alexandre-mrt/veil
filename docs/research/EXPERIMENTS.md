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
   permitted). Blocked twice now for different reasons (see LEDGER 2026-07-22) — worth spending an
   early part of the next run purely on unblocking the toolchain before attempting the measurement.

2. **Poseidon2 at `t=4`/`t=5` (self-derived parameters — commitments, nullifiers, `txAmountHash`).**
   ~~Poseidon2 vs current Poseidon~~ (this item, at `t=3`) is **settled 2026-09-19 — REJECT for
   production**: measured −0.3% constraints / −2% to −6% real Groth16 proving time for the depth-20
   Merkle-hash path (the only width with published, audited BN254 Poseidon2 parameters), real but
   too small to clear the migration cost (VK timelock, a breaking Merkle-tree hash-family change,
   added audit surface for a 2023-published primitive). See `LEDGER.md` /
   `2026-09-19-poseidon2-merkle-swap.md`. Re-opened here, narrower and harder: the *other* three
   Poseidon call sites per circuit — `Poseidon(3)` (txAmountHash, `t=4` internally) and `Poseidon(4)`
   (commitments/nullifiers, `t=5` internally) — are where most of each circuit's non-linear
   constraints actually live, and Poseidon2's `O(t)` vs `O(t²)` full-round advantage should matter
   more as `t` grows. Closing this needs running the Poseidon2 paper's own constant-generation
   script for untested widths and independently validating the result (no existing KAT to check
   against, unlike the `t=3` case) — meaningfully higher-risk than transcribing published constants.
   Worth exactly one focused night: generate + validate the parameters first, stop there and PARK if
   validation is shaky, only build circuits if it holds up.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

4. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). Note: if this or item 2 above
   ships, `templates/merkle_proof_poseidon2.circom` (this session) is the hash gadget to reuse for
   any new Merkle-tree circuit variant, rather than re-deriving one.

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
   If this ever happens, revisit the Poseidon2 REJECT above — a proof-system migration already pays
   the "new verifying key" cost that sank Poseidon2's cost/benefit tonight, so bundling both changes
   could flip the verdict.

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
    2026-09-19 hit the identical symptom in `scripts/bench/prove-latency.mjs` and in
    `scripts/src/test-compliance-utils.ts` — same root cause, wider blast radius than previously
    scoped (not just `circuits`' `npm test`). Worth fixing the underlying `snarkjs`/`ffjavascript`
    lingering-handle issue once, rather than re-discovering the workaround (never pipe a real-proof
    run through `tail`/`head` in a backgrounded shell — redirect straight to a file instead) every
    session.
