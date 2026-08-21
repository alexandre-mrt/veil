# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked three times running
   now (see LEDGER 2026-07-22 and 2026-08-21) — the 2026-08-21 run confirmed this is a **policy-level**
   block, not a missed attempt: this session's outbound proxy returns HTTP 403 for `github.com`,
   `crates.io`, and the Sui testnet fullnode alike (raw probe output in
   `2026-08-21-poseidon2-hash.md`). Re-attempting with the same tools a fourth time is unlikely to
   succeed — needs either a network-policy change for this research loop's sessions, or explicit
   permission for a specific alternative measurement path (e.g. a pre-fetched gas-cost dataset
   supplied out of band). Worth raising with whoever configures the loop rather than silently
   retrying forever. Stays ranked #1 on value (it's still `BASELINE.md`'s one missing axis and
   gates item 3 below) even though it isn't attemptable with current tools.

2. **Wide-arity Poseidon2 batch benchmark.** 2026-08-21 measured Poseidon2 (via
   `@taceo/circom-lib`) against Veil's actual narrow-arity hash workload (2-4 data elements per
   call, mostly small Merkle nodes) and got a clear **REJECT**: non-linear constraints dropped
   ~10% as expected, but linear constraints grew more and Node proving time regressed 7-24% across
   all three circuits (`2026-08-21-poseidon2-hash.md`). That result doesn't rule out a win at wider
   arity — Poseidon2's structural advantage amortizes better over more absorbed elements per
   permutation. A synthetic benchmark hashing 8-16 elements per call (e.g. an 8-element batch
   commitment, comparable in shape to a future batched-transfer design) directly tests whether
   Poseidon2 is worth reconsidering there before item 9 (trusted-setup elimination) or any other
   multi-night circuit migration gets designed around today's REJECT verdict. Reuses
   `scripts/bench/poseidon2-prove-latency.mjs`'s pattern directly.

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
   port, not a parameter change. Item 2 (Poseidon2) is now settled REJECT for the narrow-arity case,
   so this doesn't need to wait on it any further; still large enough to want item 5 (soundness
   audit) done first so a proof-system swap isn't built on an unaudited circuit.

10. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

11. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

12. **Diff `@taceo/circom-lib`'s Poseidon2 round constants against the HorizenLabs reference sage
    script.** Flagged as an open assumption in `2026-08-21-poseidon2-hash.md`: tonight's
    cross-validation confirmed the circom template agrees with `@taceo/poseidon2`'s raw permutation,
    but both packages share a publisher — neither was diffed against the independent
    HorizenLabs parameter-generation script itself, because that requires GitHub access (blocked,
    see item 1). Cheap once GitHub access exists; moot if item 2's wide-arity result also comes
    back REJECT and Poseidon2 is dropped from consideration entirely.

13. **Split witness-generation time from FFT/MSM time in the proving-time benchmarks.** Open
    question from 2026-08-21: `prove-latency.mjs`/`poseidon2-prove-latency.mjs` both time
    `snarkjs.groth16.fullProve` (witness + proving) as one number, matching 2026-07-22's original
    methodology. Timing `snarkjs.wtns.calculate` and `snarkjs.groth16.prove` separately would show
    whether a future regression (like 2026-08-21's) is in witness arithmetic or the QAP/FFT/MSM
    stage — useful for item 2 above regardless of which way it comes back. Small script change, not
    a new circuit; fold into whichever night runs item 2.

14. **Fix `circuits`' chained `npm test` hang — and the same hang in `scripts/bench`.** Not a
    research experiment — a small tooling papercut, first noticed during the 2026-07-22 baseline
    run and reconfirmed 2026-08-21: real (non-hash-only) `snarkjs.groth16` calls leave the Node
    process alive after the script finishes printing results (confirmed again tonight in
    `poseidon2-prove-latency.mjs`, which had to be force-killed after its output was already fully
    written). Stalls any `&&`-chained script after the first real-proof file/circuit. Each file
    passes fine run individually or with output redirected to a file instead of piped through a
    buffering command. Low priority; fold into whichever future night touches `circuits/test/` or
    `scripts/bench/`.
