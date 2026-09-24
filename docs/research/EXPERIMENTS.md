# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

**Re-ranked 2026-09-24** after auditing the open-PR backlog and fixing the recipient-binding
vulnerability (RR10 / E7) that a prior unmerged run (`#71`) had found but never landed. See
`docs/research/2026-09-24-recipient-binding-fix.md` for the full audit.

1. **Triage the open-PR backlog. This is not a research experiment — it's what's actually
   blocking every one below it.** 10 open PRs (`#64`-`#73`, opened nightly since 2026-07-28) sit
   unmerged, mostly independently re-deriving the same two experiments (≥5 Poseidon2 variants,
   ≥3 on-chain gas variants) because two CI infra bugs (`oven-sh/setup-bun`'s SHA pin no longer
   resolving; `storage.googleapis.com`'s ptau host 403ing GitHub-hosted runners) kept the suite
   red for ~2 months and got independently rediscovered/fixed 5+ times without ever merging.
   `#68` has a real localnet gas measurement with green CI (`mergeable_state: clean`) and is the
   best candidate to merge first; then the ~9 PRs it and earlier audits supersede should close. A
   scheduled research run shouldn't merge to `main` or bulk-close PRs unilaterally — this needs a
   human pass. Until it happens, every night risks re-deriving results that already exist on some
   unmerged branch.

2. **On-chain gas per entry point.** `BASELINE.md`'s one still-missing axis on `main` (the fix
   was measured multiple times on unmerged branches — `#66`, `#68` — but none of that landed).
   Once the backlog above is triaged, re-verify and merge the best existing measurement rather
   than re-running from scratch; the toolchain unblock itself is no longer the hard part — a
   `sui` release binary matching `Move.toml`'s pinned framework rev downloads directly from
   `github.com/MystenLabs/sui/releases/download/...` (confirmed working 2026-09-24, see this
   session's report) even when `storage.googleapis.com` and `api.github.com` are both blocked.

3. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Extensively explored across
   at least 5 unmerged nights (`#64`, `#65`, `#67`, `#72`, `#73`) with consistent findings: no
   real gas benefit, a small (~3-6%) proving-time win at best, no standard parameterization for
   the t=5/t=6 arities Veil's identity/credential hashes need, and no vetted reference
   implementation to build a real production swap on safely. Treat as **settled REJECT** by
   volume of evidence even though none of those PRs are merged — do not re-run again without a
   specific new angle (e.g., a newly-published, audited Poseidon2 BN254 reference implementation
   appearing).

4. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Depends on item 2
   (a real per-verify gas number) to size the actual savings.

5. **Merkle accumulator at scale (10^5-10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off), indexer throughput. Relevant to
   `docs/threat-model.md` RR5.

6. **Independent circuit soundness audit.** Under-constrained signals, alias checks, nullifier
   collision analysis, proof malleability — adversarial, not a redesign. Note: this session found
   the highest-value soundness bug in the loop's history not by auditing the circuits, but by
   auditing the *Move-side consumption* of a circuit's public inputs (E7/RR10) — worth treating
   "does the contract actually check every public input it extracts" as its own checklist item
   here, not just circuit-internal soundness.

7. **Threshold auditing (t-of-n) vs the single auditor key.**

8. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.**

9. **Mobile WASM proving latency.** Cheap extension of `scripts/bench/browser-latency.mjs`.

10. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Large lift; wait until items
    2-3 are actually merged and settled before committing a multi-night proof-system swap.

11. **Post-quantum exposure.** Likely design-only/UNMEASURED.

12. **Relayer throughput and leakage under load.**

13. **`docs/zk-vulnerability-research.md` doesn't name "unchecked public input" as its own bug
    class.** New, cheap: E7/RR10 (2026-09-24) was exactly this — a circuit-level binding that was
    real, but never checked by the contract consuming it. Worth a line in that doc so future
    circuit reviews check both halves (circuit constraint *and* on-chain consumption), not just
    the circuit.

14. **`compliance-utils` test suite is slow enough to matter.** `test-compliance-utils.ts`'s
    `buildMerkleTree` at depth 20 is O(2^depth) and now measurably slows down the full-suite run
    (still running after 4+ minutes during this session's pre-PR check, vs. seconds for every
    other suite). Previously noted as unmeasured/low-priority in unmerged branches; worth an
    actual before/after number next time someone touches `compliance-utils.ts`.

15. **`frontend`'s `useWithdraw` hook calls `pool::emergency_withdraw` (admin-only), not
    `pool::zk_withdraw`.** The real user-facing ZK withdrawal path this session's fix protects
    has no wired frontend caller yet. Before shipping a real withdraw button, confirm the
    proving code uses the recipient field-element convention this fix depends on (BE address mod
    BN254 field, documented in `withdraw.circom` and `verifier::recipient_to_field`).

16. **Fix `circuits`' chained `npm test` hang.** Still present, still low priority (each test
    file passes fine run individually; only the `&&`-chained script hangs after the first file).
