# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

Re-ranked 2026-08-15: item 2 (Poseidon2 vs current Poseidon) is now **settled REJECT** — see
`LEDGER.md` and `2026-08-15-poseidon2-benchmark.md` — and dropped from this list. Item 1 (on-chain
gas) is confirmed blocked by *session network policy specifically* (not by toolchain difficulty),
so it's re-ranked below items a differently-scoped session could actually make progress on tonight;
still worth top billing whenever a session has broader network/GitHub access. Two new, narrower
items replace the old item 2, carrying forward what tonight's measurement actually showed.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked twice now in two
   different sessions, for two different reasons each time (see LEDGER 2026-07-22 and 2026-08-15).
   Tonight's attempt got concrete proxy-level evidence: JSON-RPC to any public Sui fullnode returns
   a hard 403 from the egress policy, `static.crates.io` (needed to build `sui` from source via
   cargo) is separately blocked, and this session's GitHub access is scoped to `alexandre-mrt/veil`
   only (denies `MystenLabs/sui`, which a from-source build also needs). None of this is fixable
   from inside a session — it needs a session configured with a prebuilt `sui` binary reachable from
   an allowed host, or broader GitHub/crate-registry access. Don't re-attempt with the same
   toolchain-unblocking approach; check network/GitHub scope first.

2. **Custom Poseidon2 round constants for t=5 and t=6.** `@taceo/circom-lib@0.6.0` — the only
   off-the-shelf circom Poseidon2 implementation reachable tonight — only ships round constants for
   t ∈ {2,3,4,8,12,16}, which forces Veil's most common hash calls (`Poseidon(4)` — 4 instances in
   `transfer.circom` alone, `Poseidon(5)` in `compliance.circom`) to pad to t=8, costing 99-126% more
   R1CS constraints than circomlib's current Poseidon (measured 2026-08-15,
   `2026-08-15-poseidon2-benchmark.md`). Native t=5/t=6 constants would remove that tax entirely and
   could flip the 2026-08-15 REJECT into a KEEP. Needs independently-verifiable derivation (the
   Poseidon2 paper's reference generation script, or a second published implementation to diff
   against) — not a single-session hand-roll of untrusted constants. Worth attempting in a session
   with wider network/paper-mirror access.

3. **Collapse `@taceo/circom-lib`'s linear-layer codegen.** Even at *native* widths with no padding,
   its `Poseidon2(t)` costs more linear constraints than circomlib's Poseidon (measured: 340 vs 274
   at t=3, n=2; 588 vs 341 at t=4, n=3) because `ExternalMatMulT`/`InternalMatMulT` expand the
   MDS/diagonal linear layer into many named intermediate signals rather than one dense linear
   combination per output wire. This is an implementation/codegen inefficiency, not a property of
   the Poseidon2 permutation itself — collapsing it by hand (without touching round constants, so no
   new soundness risk) is a scoped, low-risk optimization worth 30-60 minutes on a lighter night, and
   would make any future Poseidon2 attempt (see item 2) materially more competitive even without
   solving the t=5/t=6 gap.

4. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save) — still blocked transitively.

5. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). Note: `scripts/src/compliance-
   utils.ts`'s `buildMerkleTree` already gets slow at depth 20 in pure JS (circomlibjs Poseidon,
   ~single-digit minutes for the full test run) — a real throughput number for this experiment should
   measure that cost explicitly, not just note it in passing.

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

10. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
    `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
    port, not a parameter change — so this should wait until the constraint-count picture (items
    2-3) settles before committing a multi-night effort to a proof-system swap.

11. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

12. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

13. **Fix `circuits`' chained `npm test` hang.** Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run: real (non-hash-only) `snarkjs.groth16`
    calls leave the Node process alive after the test file finishes printing results, which stalls
    the `&&`-chained `npm test` script after the first file. Each file passes fine run
    individually. Low priority; fold into whichever future night touches `circuits/test/`.
