# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked three times now, for
   three different reasons each time (see LEDGER 2026-07-22, 2026-08-07) — as of 2026-08-07, network
   is no longer the blocker (`git clone`/`cargo install` of `MystenLabs/sui` both work from this
   sandbox); the blocker is now purely compute: a full `sui` CLI build pulls in most of the Sui
   workspace and is a multi-hour job on 4 vCPUs. Even a built CLI can't reach
   `fullnode.testnet.sui.io` (confirmed still network-blocked independent of the CLI) — the real path
   is a fully local `sui start` network (genesis + validator + faucet, no external network needed),
   publish `contracts/` locally, exercise each entry point with real proofs, read gas from local tx
   effects. Next attempt should budget a dedicated multi-hour build, or kick one off at the very
   start of a night and let it run in the background across that night's actual (different)
   experiment rather than blocking on it synchronously.

2. **Merkle accumulator at scale (10^5–10^7 commitments).** Re-ranked up from #4 on 2026-08-07: the
   constraint-attribution experiment that night measured the depth-20 Merkle-membership check (20×
   `Poseidon(2)`) at 75–80% of `transfer.circom`'s and `compliance.circom`'s entire non-linear
   constraint count — bigger than every other Poseidon call in either circuit combined, and the
   single highest-leverage lever available for prover time in both circuits. Batch insertion cost,
   depth-20 vs a deeper tree (anonymity-set size vs proving-time trade-off directly, since depth is
   now known to cost ~246 non-linear constraints per level), and indexer throughput for
   reconstructing the tree client-side. Directly relevant to `docs/threat-model.md` RR5
   (deposit-commitment linkability). A cheap first step: compile `MerkleProof(depth)` at a few more
   depths and confirm the ~246/level marginal cost directly rather than relying on tonight's
   single-depth extrapolation.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

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

8. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding) / Poseidon2.** Directly addresses
   `docs/threat-model.md` RR2 (dev-only single-contributor ceremony), and subsumes the old
   "Poseidon2 vs Poseidon" item (settled 2026-08-07, see LEDGER — constraint attribution done
   instead of a literal swap). **Before ranking this up**: verify the 2026-08-07 report's literature
   pointer (unconfirmed against the primary source — network-blocked) that Poseidon2's real
   advantage is Plonk-style arithmetization, not R1CS/Groth16 (~240 constraints/hash either way per
   that source). If that holds, a Poseidon2 port buys little for Veil's current proof system and
   this item is really "should Veil's proof system change," a much larger question than a hash swap.
   Large lift either way — a full circuit port, not a parameter change.

9. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
   computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
   experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
   migration path would cost, not a benchmark.

10. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

11. **Fix `circuits`' chained `npm test` hang.** Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run: real (non-hash-only) `snarkjs.groth16`
    calls leave the Node process alive after the test file finishes printing results, which stalls
    the `&&`-chained `npm test` script after the first file. Each file passes fine run
    individually. Low priority; fold into whichever future night touches `circuits/test/`.
