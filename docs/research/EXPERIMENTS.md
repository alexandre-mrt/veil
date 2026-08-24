# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

**2026-08-24 re-rank note:** item 2 (Poseidon2 Merkle hasher) is now settled **REJECT** — removed
from the active list (see `LEDGER.md` and the full writeup). On-chain gas (previously #1) is
demoted: it has now been blocked on three separate nights for three different reasons (tool-approval
denial, CLI unbuildable within budget, and — tonight — an outright network-proxy policy denial to
the testnet fullnode). A fourth attempt with no new angle would just burn another night; it stays
queued but below items that don't share its dependency. The former #12 ("fix `circuits`' chained
`npm test` hang") is removed — verified resolved tonight: all three `circuits/test/*.mjs` files
already call `process.exit(0)`, and `npm test` now runs the full three-file chain cleanly (confirmed
by running it). The one place the same bug still existed, `scripts/bench/prove-latency.mjs`, got the
same one-line fix as a side effect of tonight's benchmarking. A new item (the hand-fused Poseidon2
linear layer) is added from tonight's open questions, ranked low — real crypto-engineering risk for
a maybe-win, not a default next move.

1. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented. No dependency on the blocked gas work.

2. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). No dependency on gas.

3. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
   (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
   profile (`page.emulate(...)`) and compare against the desktop-headless numbers already in
   `BASELINE.md`. Good "spend an hour, get a real number" candidate for a lighter night.

4. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.
   A t-of-n threshold scheme (or even measuring the cost of a naive N-of-N re-encryption) changes
   the trust model for compliance data meaningfully and is a natural fit for the "confidential
   payroll with a t-of-n auditor board" use case named in the 2026-07-22 report.

5. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock). An
   RSA or Merkle-based revocation accumulator could make single-credential revocation cheaper
   without a full root rebuild — worth a real cost comparison, not just a design note.

6. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis, demoted from #1 (see re-rank
   note above). Blocked three times now, most recently by an outright proxy-level policy denial to
   `fullnode.testnet.sui.io` — not a transient failure. Don't retry with the same approach; needs
   either a genuinely new angle (explicit user-granted network exception, a `sui` binary reachable
   through an already-allowed host, or an offline/local-network alternative) before spending another
   night on it.

7. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Still depends on item 6 existing first (need a real per-verify gas number to know how much this
   would actually save) — ranked below item 6 for that reason even though it's independently
   interesting.

8. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
   `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
   port, not a parameter change — so this should wait until items 1–2 give a clearer picture of
   what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

9. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
   computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
   experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
   migration path would cost, not a benchmark.

10. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

11. **Hand-fused Poseidon2 linear layer (re-attempt of 2026-08-24, PARKED).** The 2026-08-24
    experiment found Poseidon2(t=3) *increases* R1CS constraints and proving time versus plain
    Poseidon(2), because `@taceo/circom-lib`'s `ExternalMatMulT`/`InternalMatMulT` templates encode
    each MDS-matrix multiply through several named intermediate signals, and circom emits one linear
    constraint per named signal. A hand-written linear layer (one fused expression per output wire,
    circomlib-`Mix`-style) using the *same, already-verified* round constants could plausibly
    recover the non-linear-constraint win this experiment measured (−0.9% to −1.0%) without the
    linear-constraint cost that sank it (+18.5%/+19.7%/+4.1%). Ranked low deliberately: writing a
    custom linear layer by hand is real cryptographic-engineering risk for a "maybe" win, not a
    default next move — only take this if someone is specifically willing to re-verify the hand-fused
    version against the same cross-implementation check tonight's experiment used.
