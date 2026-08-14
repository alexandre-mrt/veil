# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

**Re-ranked 2026-08-14** after the constraint-decomposition experiment (see
`2026-08-14-poseidon-constraint-decomposition.md`): the old item 2 ("Poseidon2 vs current Poseidon")
is settled via its alternate framing (KEEP — exact non-linear decomposition), and its finding — the
depth-20 Merkle path, not the domain-tag hashes, is 76–81% of the relevant circuits' non-linear
cost — reprioritizes items 3/4 below and rescopes what a future Poseidon2 experiment should actually
measure.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked twice now, for
   different reasons each time (see LEDGER 2026-07-22 and 2026-08-14) — the 2026-08-14 retry
   confirmed both are policy denials, not toolchain gaps: the egress proxy denies the public Sui
   fullnode RPC host (403 on CONNECT), and this session's GitHub access is scoped to
   `alexandre-mrt/veil` only, so `MystenLabs/sui` (needed to build/fetch the `sui` CLI) is
   unreachable regardless of network policy. **This one is not unblockable by another automated
   retry** — it needs a human to either widen the session's repo scope to include `MystenLabs/sui`
   or add `fullnode.testnet.sui.io` to the egress allowlist. Still top of the queue so the next run
   checks whether either has changed, but don't spend the whole night on it if neither has.

2. **Merkle depth vs. proving time, confirmed by recompile.** The 2026-08-14 decomposition
   established a clean linear model — each accumulator level costs exactly 246 non-linear / 274
   linear constraints (verified 20/20 for the current depth-20 tree). Cheap, high-confidence next
   step: actually recompile `MerkleProof(24)` and `MerkleProof(28)` with the gadget harness that
   already exists (`scripts/bench/poseidon-gadgets/merkleproof20.circom` — just parameterize the
   depth) and confirm the model holds outside the depth-20 case it was fit to, then measure the
   actual proving-time delta (not just constraint count) at each depth. Directly feeds
   `docs/threat-model.md` RR5 (deposit-commitment linkability / anonymity-set size) with a real
   depth-vs-cost curve instead of a guess.

3. **Poseidon2(2), rescoped to the Merkle path specifically.** The old queue item 2 asked for a
   general Poseidon-vs-Poseidon2 comparison; 2026-08-14 narrowed the actual target: since the
   Merkle accumulator (built entirely from `Poseidon(2)` calls, 20 of them per proof) is 76–81% of
   `transfer.circom`'s and `compliance.circom`'s non-linear cost, an isolated, reference-verified
   Poseidon2(2) permutation's constraint count — compared against the measured 243 non-linear /
   274 linear for `Poseidon(2)` — predicts almost the entire achievable saving before touching a
   real circuit. Needs a trustworthy Poseidon2 circom implementation to compile against (rejected
   hand-deriving round constants/matrix in the 2026-08-14 report — too easy to ship a broken
   permutation disguised as a benchmark). Find or port a verified reference first; that's most of
   the lift.

4. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

5. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, indexer
   throughput for reconstructing the tree client-side, and — now informed by item 2's per-level
   cost model — the concrete prover-time cost of whatever depth a larger anonymity set would need.

6. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented.

7. **Threshold auditing (t-of-n) vs. the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.
   A t-of-n threshold scheme (or even measuring the cost of a naive N-of-N re-encryption) changes
   the trust model for compliance data meaningfully and is a natural fit for the "confidential
   payroll with a t-of-n auditor board" use case named in the 2026-07-22 report.

8. **Revocation-friendly accumulators vs. the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock). An
   RSA or Merkle-based revocation accumulator could make single-credential revocation cheaper
   without a full root rebuild — worth a real cost comparison, not just a design note.

9. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
   (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
   profile (`page.emulate(...)`) and compare against the desktop-headless numbers already in
   `BASELINE.md`. Good "spend an hour, get a real number" candidate for a lighter night.

10. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
    `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
    port, not a parameter change — so this should wait until items 2–3 give a clearer picture of
    what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

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
