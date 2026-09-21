# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

**Before picking an item, check the open-PR backlog** (`list_pull_requests`, `state=open`). As of
2026-09-21 there are 27 open PRs, most of them independent re-derivations of settled items #2 and
#1-as-they-were-ranked-before-tonight, because CI has been red for two months on two unrelated infra
bugs and nothing has merged since 2026-07-22. See `LEDGER.md`'s 2026-09-21 row and
`2026-09-21-backlog-audit-and-recipient-binding-vuln.md` before re-running anything below — the
ledger and this queue may already be stale again by the time you read them if that backlog still
hasn't merged.

1. **Fix RR10: `zk_withdraw` doesn't bind `recipient` to the proof.** `docs/threat-model.md` E7/RR10
   (added 2026-09-21). `pool::zk_withdraw` never checks `recipientHash` (public input bytes 96-128)
   against the caller-supplied `recipient` — confirmed by direct code read against current `main`,
   not an unmerged PR's claim. Anyone who observes a pending withdrawal's proof can redirect its
   payout to themselves. Needs: an on-chain binding (compute `Poseidon(8, recipient)` on-chain and
   assert equality, or — simpler, since `recipient` is already not anonymous per `README.md` —
   change `withdraw.circom` to expose `recipient` as a raw public input instead of a hash of it),
   a soundness argument, a negative test (recipient-substitution rejected), and a VK rotation
   either way. This is a real, unmitigated fund-theft-class bug — highest priority regardless of
   what else is queued.

2. **Merge PR #68 / close the duplicate backlog (process, not research).** #68
   ("research: on-chain gas per entry point, measured on a local network") is fully green (CI
   `success`) and `mergeable_state: clean`. It closes what was queue item #1 (on-chain gas, via a
   local Sui network + a version-matched `sui` CLI fetched from GitHub releases — not testnet RPC,
   which stays blocked in this sandbox) and folds in both recurring CI-infra fixes. Merging it and
   closing the ≥25 PRs it supersedes (#41-#67, #69, #70) is the single highest-leverage action
   available to unstick this loop — not a research question, but blocking every research question
   below from landing. Needs the repo owner's decision (a scheduled run shouldn't merge to `main` or
   bulk-close PRs unilaterally).

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification. PR #68's (unmerged) finding that Groth16
   verification cost is flat/bucketed rather than constraint-count-driven changes this item's
   expected payoff — re-read #68's own report once merged rather than re-deriving that finding a
   7th time.

4. **Merkle accumulator at scale (10^5-10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off, since Merkle depth is a circuit
   parameter — and per tonight's per-instance constraint measurement, the depth-20 Merkle path is
   ~76% of `transfer.circom`'s total constraints, by far the dominant cost), and indexer throughput
   for reconstructing the tree client-side. Directly relevant to `docs/threat-model.md` RR5
   (deposit-commitment linkability). **Do not reduce Merkle depth purely to cut constraints without
   weighing the anonymity-set cost** — RR5 explicitly relies on tree depth for anonymity-set size.

5. **Independent circuit + contract soundness audit.** Under-constrained signals, alias checks
   (BN254 field wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier
   collision analysis, proof malleability — **and, per tonight's finding, the same class of bug as
   RR10 elsewhere**: for every public input a circuit derives from something the caller also
   supplies as a plain contract argument, confirm the contract actually checks the two match.
   `shielded_transfer`/`compliant_transfer` haven't been re-checked against this specific pattern.

6. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.

7. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock).

8. **Mobile WASM proving latency.** Cheap extension of the existing browser-proving harness
   (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
   profile (`page.emulate(...)`).

9. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
   `docs/threat-model.md` RR2. Large lift — a full circuit port — so this should wait until items
   above give a clearer picture of what's actually worth a multi-night proof-system swap.

10. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer. Likely design-only/UNMEASURED.

11. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing is
    unmeasured.

12. **Fix `circuits`' chained `npm test` hang.** Small tooling papercut — real (non-hash-only)
    `snarkjs.groth16` calls leave the Node process alive after the test file finishes, stalling the
    `&&`-chained `npm test` after the first file. Each file passes individually. Low priority.

## Settled — do not re-run without a stated reason (see `LEDGER.md`)

- **Poseidon2 vs Poseidon (constraint count).** REJECT, independently confirmed by **at least 17
  separate research sessions** (this one included) across the loop's history (PRs #41, #42, #44-48,
  #50, #52-54, #56-58, #61, #64, #65, #67, plus tonight's own microbenchmark): swapping Poseidon for
  Poseidon2 does not reduce R1CS non-linear constraint count
  (S-box count is unchanged; Poseidon2's linear-layer improvement is free in R1CS either way), and
  the measured proving-time wins some of those sessions found (a few percent, using validated
  reference parameters) don't clear the cost of a VK rotation + new-primitive audit surface on a
  pre-audit protocol. **If a future night is tempted to re-run this, don't — read
  `2026-09-21-backlog-audit-and-recipient-binding-vuln.md` and the referenced PRs instead.**
- **On-chain gas per entry point.** Was queue item #1 for two months (BLOCKED twice, then
  independently unblocked ≥6 times via a local Sui network). Settled by PR #68 (unmerged as of
  2026-09-21, but its finding — Groth16 verification cost is flat/storage-bucketed, not
  constraint-count-driven — should be treated as authoritative once merged rather than re-measured).
