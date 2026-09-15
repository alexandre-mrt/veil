# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

**Read this before picking up item 1 or anything else below.** As of 2026-09-15, `main` has merged
nothing from this research loop since 2026-07-22 — over 60 open, unmerged `research:`/`ci:` PRs
(#18 through at least #63) sit on the repo, dated 2026-07-29 through today. CI has been red on
essentially all of them (a corrupted `oven-sh/setup-bun` pin and a now-unreachable
`storage.googleapis.com` ptau download — both diagnosed and fixed independently by at least three
different nights: #55, #62, and this one). The consequence, documented in the 2026-09-06
`ci-backlog-audit` PR (#55) and reconfirmed tonight: **the same top-of-queue items get re-run over
and over because every night starts from an unmoving `main`** that never saw the previous nights'
LEDGER/EXPERIMENTS updates. "Poseidon2 vs Poseidon" alone has been independently REJECTed at least
20+ times across unmerged branches. Tonight's own on-chain-gas experiment (see LEDGER 2026-09-15) is
itself a duplicate of PR #59's 2026-09-11 finding, discovered only *after* opening a new PR, because
the duplicate was invisible from `main`. **Before spending a night on anything in this file, check
whether the backlog has been cleared** (`main`'s `LEDGER.md` has more than the 2026-07-22 and
2026-09-15 rows) — if not, say so again rather than adding a 4th or 20th duplicate PR.

1. **Fix `zk_withdraw`'s missing recipient check — `docs/threat-model.md` RR10, Critical.**
   `pool::zk_withdraw` never checks the `recipient` address it pays out to against the proof's
   `recipientHash` public input — a relayer or front-runner can redirect any pending withdrawal to
   their own address using someone else's valid proof. Found 2026-09-11 (PR #59, unmerged),
   independently reconfirmed against current `main` 2026-09-15 (see RR10 for the exact code path
   and why the existing "front-running is prevented" comment is wrong). This is a real fund-theft
   path in unaudited pre-mainnet code, not a privacy nuance — promoted to #1 ahead of every
   performance experiment below. A fix needs: a decided Sui-`address`-to-field-element encoding
   matching `withdraw.circom`'s private `recipient` input, an on-chain equality assertion, a
   soundness argument for the encoding choice, a leakage analysis (does binding the check leak
   anything new to a chain observer? — almost certainly not, the recipient is already public in
   `transfer::public_transfer`'s event), and a negative test proving a mismatched-recipient
   resubmission aborts. Do not defer this again for a performance experiment.

2. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`), and constraint count is what drives **proving** time
   (751ms/738ms vs. 244ms per `BASELINE.md`). **Already independently REJECTed 6-20+ times** across
   unmerged branches (a naive same-arity swap loses — see PR #54's 2026-09-05 constraint-
   decomposition report, if it's still reachable, for why: the 20-level Merkle path dominates, not
   the identity-binding Poseidon calls). Do not re-run the naive-swap version again. If picked up,
   it should be the Merkle-arity/depth angle #54 already pointed at — and only once the backlog
   note above is resolved, so this isn't rediscovered from scratch an 21st time.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify), re-scoped by the
   2026-09-11/2026-09-15 gas findings (independently duplicated — see LEDGER).** Groth16
   verification computation cost is flat (Sui's cheapest gas bucket) regardless of circuit size or
   proof count. So naively batching N verifications into one PTB call would save little; the real
   lever is **storage** — N separate dynamic-field writes (one nullifier + one commitment each) vs.
   some batched insertion. Needs a genuine storage-layout redesign to be worth doing, not just a
   wrapper. Worth a small real 2-transfer-in-one-PTB measurement first to confirm the hypothesis
   before designing anything bigger.

4. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability). Has a real
   `update_commitment_root` gas number (`BASELINE.md`: ~0.0013 SUI net for a single-leaf update) to
   extrapolate batch-insertion cost from.

5. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign.
   RR10 above is exactly the kind of finding this item is meant to surface — worth noting that it
   was found in the *Move* layer, not the circuit layer, so this item's scope should include the
   contract/circuit boundary (public-input-to-on-chain-check wiring), not just the R1CS itself.

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

9. **Gas under concurrent load / shared-object contention.** Every on-chain gas measurement so far
   is from a single-validator local network processing one transaction at a time. Real gas (and,
   more importantly, latency/failure rate) for concurrent `shielded_transfer`s against the same
   shared `Pool` object is unmeasured — relevant to whether the current UTXO-dynamic-field design
   becomes a bottleneck under real traffic.

10. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
    `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
    port — so this should wait until items 2-3 give a clearer picture of what's actually worth
    optimizing before committing a multi-night effort to a proof-system swap.

11. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

12. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.
