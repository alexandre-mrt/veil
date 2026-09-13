# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

Re-ranked 2026-09-13: removed the Poseidon2 item (settled REJECT — see LEDGER and
`2026-09-13-poseidon2-arity-gap.md`) and removed the `circuits` chained-`npm test`-hang item (fixed
by commit `f942fca`, prior to tonight — the test runners now `process.exit()` explicitly after the
last proof, confirmed by running `transfer`/`withdraw`/`compliance` test files individually tonight
with no stall). Added three narrower Poseidon2 follow-ups at the bottom, none obviously
higher-value than what's already queued above them.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Needs a working `sui` CLI
   (prebuilt binary, or a from-source build budgeted across more than one night) or explicit
   permission to make direct JSON-RPC reads against the already-deployed testnet package
   (`README.md` has real package/pool/config IDs — `suix_queryTransactionBlocks` against a public
   fullnode could recover real historical gas without the CLI at all, if that network call is
   permitted). Blocked three times now for the same reason — this session's network egress policy
   denies `fullnode.testnet.sui.io` outright (`403`, confirmed again 2026-09-13) — worth spending
   an early part of the next run purely on unblocking the toolchain (a prebuilt `sui` binary from
   somewhere the egress policy does allow, or a budgeted from-source build) before attempting the
   measurement again; re-trying the same blocked network host a fourth time isn't going to change
   the answer.

2. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

3. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow).

4. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented.

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
   `BASELINE.md`. Good "spend an hour, get a real number" candidate for a lighter night.

8. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
   `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
   port, not a parameter change — so this should wait until items 1–3 give a clearer picture of
   what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

9. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
   computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
   experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
   migration path would cost, not a benchmark.

10. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

11. **Sponge-based Poseidon2 at a supported width (t=8).** Follow-up to 2026-09-13's REJECT: would
    let 6 more of Veil's 10 Poseidon call sites (the t=5/t=6 commitment and nullifier hashes) be
    tested against Poseidon2 at all, at the cost of a real domain-separation redesign (absorbing
    4-5 inputs plus a tag into an 8-element sponge with padding) that needs its own soundness
    argument — not a rerun of 2026-09-13's methodology.

12. **A different Poseidon2 circom encoding of the linear layer.** 2026-09-13's REJECT is specific
    to `@taceo/circom-lib`'s implementation choices (its `ExternalMatMulT`/`InternalMatMulT`
    templates introduce more intermediate `<==` signals than circomlib's `Mix`/`MixS`, which is
    what actually drove the total-constraint regression at default optimization). A hand-tuned or
    differently-structured circom Poseidon2 implementation might close that gap — worth checking
    before concluding Poseidon2 is categorically not worth it in circom.

13. **Poseidon2 round constants for t=5/t=6.** Would need independent cryptanalytic derivation and
    review (no published parameter set exists at these widths — see 2026-09-13), so this is a
    "don't attempt without real cryptography expertise or a published reference" item, not a
    weekend task. Listed for completeness, ranked last on purpose.
