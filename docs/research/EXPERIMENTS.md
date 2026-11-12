# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

0. **Loop health — do this before any new experiment (needs the repo owner).** As of 2026-11-12,
   research PRs #108–#117 are all open and unmerged, so this file and `LEDGER.md` on main never
   advance and nights re-run settled items (Poseidon2 has been REJECTed 4×). CI is red on main for
   infrastructure reasons: the Hermez pot15 URL (`compile.sh`, `ci.yml`) returns 403, and the
   `oven-sh/setup-bun@735343b6…` pin no longer resolves. Fix CI, then merge or close the open
   research PRs, at least their ledger rows. **A nightly run should check open `research:` PRs
   before picking an item.**

0b. **Commitment linkability (PR #117, threat-model I7, unmerged).** #117 reports that
   `oldCommitment` / `commitment` are public inputs that `pool.move` consumes by exact key, so the
   Merkle proof provides no anonymity set. This is a privacy claim that outranks every performance
   item below. Verify it on main and design the fix (Merkle-root-only public input +
   nullifier-based spend).

0c. **`circom --O2` for the production circuits.** Measured: transfer 13,611 → 6,384 constraints,
   compliance 12,743 → 5,979 (2026-11-12 and PR #117). #117 measured a 22–25% proving speed-up. Before
   adopting, re-check A/B coefficient density (`bench-variants.mjs` prints it) and re-run all 108
   real-proof tests plus a fresh setup. Requires a VK rotation (1-epoch timelock).

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Needs a working `sui` CLI
   (prebuilt binary, or a from-source build budgeted across more than one night) or explicit
   permission to make direct JSON-RPC reads against the already-deployed testnet package
   (`README.md` has real package/pool/config IDs — `suix_queryTransactionBlocks` against a public
   fullnode could recover real historical gas without the CLI at all, if that network call is
   permitted). Blocked twice now for different reasons (see LEDGER 2026-07-22) — worth spending an
   early part of the next run purely on unblocking the toolchain before attempting the measurement.
   2026-11-12: still BLOCKED (releases and fullnode return 403; from-source build of
   `testnet-v1.72.1` denied by the permission layer). Check PRs #108/#110/#112 ("onchain-gas-baseline")
   first. They may already contain numbers.

2. ~~**Poseidon2 vs current Poseidon.**~~ **SETTLED — REJECT** (2026-11-12, and PRs #113/#114/#117).
   Do not re-run for Groth16/R1CS: identical under `--O2`, and slower under `-O1` even when it
   halves the FFT domain (coefficient density). Revisit only if the proof system moves to a
   PLONK-family prover (item 9). Original text kept below for history.
   **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance from the current baseline) is the highest-leverage next number — it moves prover time
   directly, for every circuit, on every transfer.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

4. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow).

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
