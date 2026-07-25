# Experiment Queue

Ranked. Highest-ranked unsettled item is what the next nightly run should take,
unless it explicitly re-ranks with a reason. An item is "settled" once it has a
KEEP or REJECT row in `LEDGER.md`; PARK and BLOCKED stay in the queue.

Ranking bias, per the loop's own rule: prefer experiments that move a number
Veil actually pays for — prover time, gas, anonymity-set size, or a threat
currently unmitigated — over cosmetic or purely theoretical work.

## Queue

1. ~~**BASELINE.md** — measure everything once on one machine.~~ **DONE 2026-07-25** (KEEP,
   partial — see `docs/research/2026-07-25-baseline.md`). On-chain gas measurement remains
   BLOCKED (no `sui` CLI available in the research sandbox); re-queued below as its own item
   because it needs a different fix (toolchain access) than a research experiment.

2. **Sui CLI in the research environment** (tooling, not a research experiment, but blocks
   several queue items below). The nightly sandbox has `circom`, `node`, `bun`, `cargo` but no
   `sui` binary, no `apt` package for it, and building `MystenLabs/sui` from source is a
   multi-hour, multi-GB Rust workspace build that isn't realistic per-night. Options: (a) ask
   whoever configures the sandbox image to bake in a prebuilt `sui` binary, (b) find a
   pure-Node/WASM Sui simulator that can run `pool.move` tests without the full CLI, (c) accept
   gas numbers can only be measured from a session with `sui` pre-installed and mark every gas
   claim UNMEASURED until then. Whoever picks this up should resolve it as environment config,
   then immediately spend the same night on item 3 (gas is the highest-value blocked number).

3. **On-chain gas per entry point, measured** (`deposit_and_register`, `shielded_transfer`,
   `compliant_transfer`, `zk_withdraw`, admin ops) via `sui move test --gas-limit` /
   `sui client dry-run`, once item 2 is resolved. This is the single most consequential
   missing number — it's what a user or the relayer actually pays, and neither
   `docs/SPEC.md` nor the README currently cites a real figure.

4. **Poseidon2 vs current Poseidon(t) constraint/proving-time delta.** Poseidon2 claims
   ~2x fewer constraints per permutation on some parameterizations. transfer.circom spends
   6,470 of its 13,611 constraints (47%) on non-linear (mostly Poseidon) — the single largest
   lever on prover time. Build a standalone Poseidon2 circom template, measure constraint count
   and `groth16.fullProve` time head-to-head against the existing `circomlibjs`/circomlib
   Poseidon on the same machine, same ptau. High value, contained scope (no protocol change
   needed to benchmark in isolation first).

5. **Merkle accumulator at scale: batch insertion cost and depth vs anonymity-set trade-off
   at 10^5–10^7 commitments.** Depth is hardcoded to 20 (2^20 ≈ 1.05M leaves). Measure: (a)
   indexer-side batch-insertion throughput for a Poseidon Merkle tree at each order of
   magnitude, (b) whether a deeper tree (e.g. depth 24–26, ~16M–67M leaves) meaningfully
   changes `transfer.circom`'s constraint count (it's one Poseidon(2) hash per level, so
   +4 levels ≈ +4 Poseidon calls — cheap to test), (c) what depth the current 1-hour epoch
   and expected deposit volume actually need before mainnet's 30-day epoch.

6. **Batched/aggregated Groth16 verification: N transfers → 1 on-chain call.** `sui::groth16`
   charges per-verification gas; a relayer batching k independent transfer proofs into one
   aggregate proof (BLS-style aggregation doesn't apply to Groth16 directly — needs either
   a recursive SNARK wrapping k inner proofs, or Groth16's own limited batch-verification
   trick of combining multiple *public-input* checks into fewer pairing checks) could cut
   gas per transfer significantly under load. Needs item 3's gas baseline to quantify the win.

7. **PLONK/Halo2 migration feasibility (eliminate the trusted setup).** Groth16's
   per-circuit trusted setup is `RR2` in the threat model (High severity, single-contributor
   dev ceremony today). A universal-setup system removes that residual risk entirely. This is
   a large port (three circuits, new proving/verifying infra, on-chain verifier rewrite since
   `sui::groth16` is Groth16-specific) — scope as a design-only PARK first: what would the
   constraint count and on-chain verification cost look like, before committing engineering
   nights to the port.

8. **Revocation-friendly accumulator vs. the depth-20 credential Merkle tree for KYC
   membership.** Today revoking a credential means rebuilding the Merkle root
   (`update_credential_root`, 1-epoch timelock) — no per-credential revocation. An RSA/bilinear
   accumulator with individual revocation could avoid full-root churn. Compare update cost
   (root rebuild vs accumulator witness update) and circuit cost (Merkle membership vs
   accumulator membership constraint count).

9. **Threshold (t-of-n) auditing vs. the single auditor ECDH key.** `RR` not yet numbered in
   threat-model.md but implicit in asset #6 (Credential Data) and `I5`: one auditor private
   key can decrypt every compliance ciphertext. Threshold encryption (e.g. ElGamal
   threshold or a t-of-n committee re-encryption scheme) bounds a single-key compromise.
   Estimate proving/verification cost delta and update `docs/threat-model.md` I5 either way.

10. **WASM proving latency on mobile-class hardware.** The frontend proves client-side in a
    Web Worker; no number exists for anything but desktop Chromium. Needs either a real
    device/emulator lab or a throttled-CPU headless-Chromium proxy — flag as likely PARK until
    device access exists; a CPU-throttled desktop run is a legitimate (labelled) proxy in the
    meantime.

11. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` has rate limiting
    (10 req/min/IP) but no measured max throughput, and no analysis of what timing/volume
    patterns a relayer operator (or a network observer of the relayer) can infer about senders
    under concurrent load. Needs a load-test harness (`scripts/bench/`) hitting a local relayer
    instance.

12. **Nullifier-collision / proof-malleability soundness audit pass.** `docs/zk-vulnerability-research.md`
    already documents the checked bug classes; this item is a fresh adversarial pass now that
    the Merkle-membership constraint (C0) has been added to `transfer.circom` (see README's
    note about the fallback-mode blind spot that hid the missing authentication path) — check
    whether any newer circuit change reintroduced an under-constrained signal.

13. **Post-quantum exposure assessment.** BN254 pairing-friendly curve security collapses
    under a sufficiently large quantum computer (breaks the discrete-log assumption
    `sui::groth16` verification relies on). Design-only: which primitives would need to change
    (proof system, commitment scheme, on-chain verifier), rough timeline pressure, and whether
    a hybrid/PQ-hash-based commitment layer is worth prototyping now. Expect UNMEASURED
    throughout — this is a survey, not a benchmark.
