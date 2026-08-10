# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked a third time
   (2026-08-10): both paths to a number are now confirmed to be **network-policy denials**, not
   toolchain gaps — `fullnode.testnet.sui.io` RPC returns 403 through the egress proxy, and so does
   `static.crates.io` (crate downloads), which closes the "build `sui` from source" route too (the
   crates.io *index* is reachable, actual `.crate` files are not). Per `/root/.ccr/README.md`, policy
   denials should be reported, not retried or routed around — this item stays blocked until a future
   session's egress policy allows one of these two hosts. Re-verify before re-attempting; don't just
   repeat the same two curl calls again for a fourth night.

2. **Hand-optimized Poseidon2 linear layer.** 2026-08-10 measured `@taceo/circom-lib`'s Poseidon2 at
   every arity Veil uses and found it produces **more** R1CS constraints than production Poseidon
   (+12.1% Merkle t=3, +40.8% t=4, +126.0% t=8-padded t=5; +11.1% for a full `transfer_poseidon2.circom`
   prototype) — settled **REJECT** for that library as a drop-in, see LEDGER. Root cause: its
   "efficient" native-arithmetic linear layer materializes extra named signals that circomlib's
   `Mix()` folds away for free. Re-implementing `ExternalMatMulT`/`InternalMatMulT` as direct linear
   combinations (no intermediate signals) and re-measuring the same six benchmark circuits
   (`scripts/bench/circuits/`) could plausibly close most of that gap — worth one focused night before
   concluding Poseidon2 has no place in Veil's circuits. Do not re-run the unmodified-library
   comparison again; it's settled.

3. **Poseidon2 compression-mode Merkle tree (t=2).** `@taceo/circom-lib`'s own
   `binary_merkle_root.circom` hashes Merkle nodes in a narrower, Miyaguchi-Preneel-style compression
   mode (t=2, feed-forward) instead of the sponge (t=3) Veil's `MerkleProof` uses today — likely
   cheaper again on top of item 2's fix, but it's a different hash *construction*, not just a
   different permutation, so it needs its own soundness writeup (collision-resistance-only is
   sufficient for Merkle nodes and is the standard choice in zk-kit/Semaphore, but that claim wasn't
   verified for Veil's specific setup) before it's a fair comparison. Flagged 2026-08-10, not yet
   measured.

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
    port, not a parameter change — so this should wait until items 1–3 give a clearer picture of
    what's actually worth optimizing before committing a multi-night effort to a proof-system swap.
    Note (2026-08-10): Poseidon2 is the hash of choice in several recursive/folding-SNARK
    ecosystems specifically for its native-arithmetic efficiency — item 2's finding (that efficiency
    doesn't currently survive the circom/R1CS port) is a relevant caveat if this item ever assumes a
    "free" Poseidon2 circuit as a stepping stone.

12. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

13. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

(Former item 12, "fix `circuits`' chained `npm test` hang" — fixed outside this loop, see
`f942fca` "fix(circuits): exit test runners explicitly after the last proof (#17)". Removed from the
queue; no longer a papercut.)
