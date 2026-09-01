# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Arity-aware partial Poseidon2 swap: Merkle-path hasher only.** 2026-09-01 measured that a
   *full* Poseidon→Poseidon2 swap (`@taceo/circom-lib` 0.9.0, the only installable circom
   Poseidon2 library) is a net proving-time *regression* for `transfer` (+31.8%) and `withdraw`
   (+27.0%), because the library's supported widths (`t∈{2,3,4,8,12,16}`) don't cover two of
   Veil's four real arities (`t=5,6`) and padding to `t=8` crosses a Groth16 FFT domain-size
   doubling. But the depth-20 `MerkleProof` hasher uses `Poseidon(2)` (`t=3`), one of the two
   natively-supported widths, and measured a real, isolated `-3` non-linear constraints/instance
   (`×20`/proof = -60 non-linear, no padding, shouldn't cross any domain-size boundary). Swapping
   *only* that hasher — leaving the odd-arity instances as plain Poseidon — is the natural,
   lower-risk next attempt at the same idea. See `docs/research/2026-09-01-poseidon2-constraint-delta.md`.

2. **Custom Poseidon2 round constants for t=5 and t=6.** Same experiment, larger lift: generate
   (via the HorizenLabs sage parameter script `@taceo/circom-lib`'s README references) fresh,
   independently-checkable Poseidon2 round constants at Veil's actual missing arities, to make a
   *full* swap viable without the padding tax item 1 avoids by not attempting. Real cryptographic
   engineering, not a config change — budget a dedicated night, not a spare hour.

3. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked a third time on
   2026-09-01: `crates.io`'s `sui` and `sui-sdk` crates are unrelated name-squatted placeholders
   (0 deps, versions 0.0.1/0.0.0), not the Mysten Labs CLI, and no `sui-cli`/`mysten-sui`/`sui_cli`
   crate exists either — confirmed dead in under 5 minutes this run, no `cargo install` path
   exists. The JSON-RPC fallback against the deployed testnet package is now also confirmed a hard
   organizational egress-policy block (proxy returns 403 to `fullnode.testnet.sui.io:443`,
   `connect_rejected` / policy denial per `/root/.ccr/README.md`), not a transient/sandbox issue —
   do not re-attempt that route in a future session without a policy change. Re-ranked down from
   #1: three blocked attempts for three different reasons is a strong signal this needs either a
   from-source Sui build budgeted across multiple dedicated nights, or an explicit human decision
   to change the egress policy — not another single-night "spend 20 minutes unblocking it" attempt.
   Items 4 (batching, depends on this) and everything downstream remain blocked on it too.

5. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 3 existing first (need a real per-verify gas number to know how much this would
   actually save).

6. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). Note: 2026-09-01 measured
   that the depth-20 Merkle path is 75-80% of `transfer`'s/`compliance`'s non-linear constraints on
   its own (`docs/research/2026-09-01-poseidon2-constraint-delta.md`) — depth changes here compound
   directly with queue item 1's Merkle-hasher swap.

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
    port, not a parameter change — so this should wait until items 1–2 give a clearer picture of
    what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

12. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

13. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

14. **Fix the remaining `snarkjs`-lingering-handle hangs in `scripts/bench/`.** Not a research
    experiment — a small tooling papercut. The original `circuits`' chained `npm test` hang (real
    Groth16 proving leaves a Node process alive after results print) was fixed for the three test
    files by #17 (`process.exit(0)` on the success path). 2026-09-01 confirmed the same underlying
    issue is still live in `scripts/bench/prove-latency.mjs` and `browser-latency.mjs` (had to
    `kill -9` a stuck run) — `poseidon2-prove-latency.mjs` added the fix from the start; the other
    two should get the same one-line fix. Low priority; fold into whichever future night touches
    `scripts/bench/`.
