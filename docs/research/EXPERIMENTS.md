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
   permitted). Blocked three times now (see LEDGER 2026-07-22, 2026-09-17) — 2026-09-17 narrowed
   the cause to network policy specifically (`github.com` releases, `storage.googleapis.com`, and
   direct Sui-fullnode RPC are all `403`-denied at this session's proxy, while `crates.io`,
   `registry.npmjs.org`, and `raw.githubusercontent.com` are not). Next step is checking whether
   the *account's* network policy (not just a given session's) can allowlist one of those hosts —
   if not, this stays blocked indefinitely and should be re-ranked down.

2. **Adopt the Poseidon2-compression Merkle hash in `compliance.circom`, then plan a VK-rotation
   path for both.** 2026-09-17 measured a real, positive result for `transfer.circom`
   (-4.9% constraints, -4.3% zkey, -5.9% proving time — see `BASELINE.md`'s "Research candidates"
   and [`2026-09-17-poseidon2-merkle-compression.md`](2026-09-17-poseidon2-merkle-compression.md))
   but did not adopt it: no official Poseidon2 parameters exist for the identity/credential hash
   sites, so this is a Merkle-tree-only migration, and shipping it needs the timelocked on-chain
   VK-update path to actually run (production multi-contributor ceremony, frontend/relayer wasm+zkey
   swap) — real deployment engineering, not a circuit tweak. `compliance.circom` has the identical
   Merkle structure and should see the same ~5% win; measuring it is a fast follow-up, planning the
   VK rotation is the actual work.

3. **Cross-tree-level domain separation in the Merkle accumulator.** Neither `merkle_proof.circom`
   nor the new `merkle_proof_poseidon2.circom` domain-separates *between* tree levels — a crafted
   leaf value could in principle collide with a shallower internal node's hash. Pre-existing in the
   original design (not introduced by item 2 above), now shared by two circuits. An adversarial
   analysis of whether this is exploitable given Veil's specific leaf structure (always a Poseidon
   commitment/credential hash, never an attacker-chosen raw field element) would settle whether this
   is a real gap or a non-issue given the leaf domain is already constrained elsewhere.

5. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

6. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow).

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
    port, not a parameter change — so this should wait until on-chain gas and the Merkle-hash work
    (items 1–2) give a clearer picture of what's actually worth optimizing before committing a
    multi-night effort to a proof-system swap.

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
