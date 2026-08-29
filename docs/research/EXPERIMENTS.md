# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked three times now, for
   three *different* reasons (see LEDGER 2026-07-22, 2026-08-29) — the 2026-08-29 attempt confirmed
   this is an organization egress-policy boundary, not a tooling gap: `fullnode.testnet.sui.io` and
   `github.com` (both a prebuilt `sui` CLI binary and the source repo) return `403` at the proxy, and
   no real `sui` crate exists on crates.io to `cargo install` instead. A fourth silent retry with the
   same toolchain approach will not change this — this needs either an explicit egress-policy
   exception for one of those two hosts, or a different fullnode/CLI source, decided by whoever
   configures this session's network policy, not solved by another night of trying. Still ranked
   first because items 3 and 4 below need a real gas number as their own baseline, but do not
   re-attempt it without a new angle — ask instead.

2. **Does `--O2` compilation help the production circuits, independent of any primitive change?**
   The 2026-08-29 Poseidon2 experiment (see item 9, below, now settled) found `--O1` (what
   `compile*.sh` actually uses) leaves real constraint-reducing linear simplification on the table —
   `--O2` collapsed away 100% of it for the Poseidon benchmark circuits, at zero cost to correctness
   (same permutation, smaller R1CS). This is a much smaller, better-isolated experiment than any
   primitive swap: recompile `transfer.circom`/`compliance.circom`/`withdraw.circom` with `--O2`,
   diff constraint counts and proving time against `BASELINE.md`, confirm the existing 108/108
   circuit tests still pass unchanged against the `--O2` artifacts (same circuit semantics, different
   R1CS — but that equivalence should be verified, not assumed) before ever re-baselining on it.

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

9. **Does Poseidon2 win at wide state (t=8/12/16) in genuine multi-element sponge mode?** The
   2026-08-29 experiment (item below, settled) only tested narrow, single-permutation-call fixed
   hashing — Veil's actual current use, where Poseidon2 turned out to cost *more* constraints than
   circomlib's Poseidon, not fewer. Poseidon2's own literature targets wide sponge/tree hashing
   absorbing many elements per call, which Veil doesn't do today. Only worth measuring if item 4
   (Merkle accumulator at scale) ever changes the accumulator's per-node hash arity to something wide
   enough to test it honestly.

10. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
    `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
    port, not a parameter change — so this should wait until items 1–2 give a clearer picture of
    what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

11. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

12. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

## Settled (kept for history, no longer ranked)

- ~~Poseidon2 vs current Poseidon (arity, domain-tag collisions).~~ **Measured 2026-08-29** — see
  LEDGER and
  [`2026-08-29-poseidon2-primitive-delta.md`](2026-08-29-poseidon2-primitive-delta.md). At Veil's
  actual arities (2/3/4/5) and actual compile flags (no `--O2`), Poseidon2 costs *more* R1CS
  constraints than circomlib's Poseidon (+12% to +126%, worst for the dominant `Poseidon(4)` call
  since Poseidon2 has no t=5 and pads to t=8); proving time doesn't clearly favor either at this
  scale. A full protocol migration is not justified by this result. Replaced above by two narrower
  follow-ups the same data motivates (items 2 and 9).

- ~~Fix `circuits`' chained `npm test` hang.~~ **Fixed** outside this loop — `f942fca`
  ("fix(circuits): exit test runners explicitly after the last proof", PR #17) — no longer a
  papercut for future nights.
