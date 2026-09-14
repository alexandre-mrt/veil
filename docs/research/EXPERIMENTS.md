# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

## 0. Before starting: check the actual backlog, not just this file

As of 2026-09-14, `main` had **30 open, unmerged `research:` PRs** (#32-#61, 2026-08-14 through
2026-09-13) because CI's `circuit-tests` job was unconditionally red (see item 3, now fixed). If you
land here and `LEDGER.md` looks suspiciously thin relative to how many nights this loop has run,
run a PR listing against the real repo before assuming this file's ranking is current — a queue item
marked open here may already be answered, just not merged yet. Cite the PR directly if so (as this
file now does for item 1) rather than silently re-running it.

1. **RR10 fix — `zk_withdraw` recipient-binding gap (Critical, confirmed real, exploitable today).**
   `contracts/sources/pool.move:571-632` extracts `recipientHash` from the proof's public inputs but
   never checks it against the caller-supplied `recipient` address — a relayer or mempool-watcher can
   resubmit a valid withdrawal proof with a different recipient and steal the payout. First found
   2026-09-11 (PR #59), documented as `docs/threat-model.md` RR10 in PR #60 (2026-09-12),
   independently re-confirmed against current `main` 2026-09-14. Needs a human design decision
   between (a) an on-chain Poseidon-over-BN254 check in Move (no native primitive — real
   implementation risk) or (b) a breaking circuit change exposing `recipient` as a raw public input
   instead of a hash of it (new VK, new trusted setup, proof-generation code updated in lockstep).
   Top of the queue by a wide margin — the only Critical, confirmed-exploitable finding here.

2. **On-chain gas per entry point.** `BASELINE.md`'s one missing performance axis. As of 2026-09-14,
   confirmed BLOCKED more conclusively than before: five public Sui JSON-RPC endpoints
   (`fullnode.testnet.sui.io`, `fullnode.mainnet.sui.io`, `sui-testnet.public.blastapi.io`,
   `sui-testnet-rpc.publicnode.com`, `rpc.ankr.com`) all denied at the network-policy level, not a
   one-off tool-approval prompt. Unmerged PR #59 reportedly unblocked this via a **local Sui network**
   instead of the public one — worth checking whether that approach is reproducible here before
   trying the public RPC path again.

3. ~~**CI's Powers-of-Tau download blocker.**~~ **FIXED 2026-09-14.** `.github/workflows/ci.yml`'s
   `circuit-tests` job downloaded `pot15_final.ptau` from `storage.googleapis.com`, which returns
   `403` to GitHub Actions runners — failing that job on literally every PR regardless of content,
   which is the actual reason `main` had one ledger row across ~30 nightly runs. Replaced with local
   Powers-of-Tau generation (`snarkjs powersoftau new/contribute/prepare phase2`, no network), same
   fallback added to `circuits/scripts/compile.sh`. Validated end-to-end: real zkeys generated for
   all three circuits, 108/108 circuit tests passing in full-proof mode. See
   `docs/research/2026-09-14-ci-ptau-blocker-and-constraint-attribution.md`.

4. **Triage the other ~28 unmerged backlog PRs (#32-#59 minus #59, #60, #61 already read).** Several
   likely contain real, non-duplicate findings currently invisible to `main` — e.g. a from-scratch
   Poseidon2 KAT cross-validation in PR #60's kept-along report that *contradicts* PR #42's earlier
   measurement of the same swap (small KEEP vs. REJECT, different template implementations). This
   report deliberately did not adjudicate that backlog — needs either a human triage pass or a future
   night willing to read all ~28 PR bodies and reconcile conflicts. Not a "redo the experiment" task;
   a "read what's already there" task.

5. ~~**Poseidon2 vs current Poseidon.**~~ **Answered, not yet merged.** Unmerged PR #61 (2026-09-13)
   measured this properly at Veil's actual call arities (2, 3, 4): REJECT — +12.2% to +40.8% total
   constraints at default optimization (the linear layer, not the S-box, regresses), parity to a
   small regression at `--O2`, and 6 of 10 call sites have no published Poseidon2 parameter set at
   any library checked. `docs/research/2026-09-14-ci-ptau-blocker-and-constraint-attribution.md`
   independently corroborates *why*: the dominant cost (76-82% of non-linear constraints in the two
   circuits with a Merkle path) is 20 calls to one arity, not spread across the four arities a swap
   would touch. **Do not re-run this a ninth time** — if PR #61 doesn't merge on its own, port its
   finding into `LEDGER.md` directly rather than re-measuring.

6. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification. Depends on item 2 (needs a real per-verify
   gas number to know how much this would actually save).

7. **Merkle accumulator at scale (10^5-10^7 commitments) — now partly scoped.** 2026-09-14 found and
   measured a concrete blocker: `scripts/src/compliance-utils.ts`'s `buildMerkleTree` is O(2^depth)
   with no cached-zero-subtree optimization — 64.2s (measured) to build a depth-20 tree with a
   *single* real leaf. Fine today (near-empty testnet pool); does not scale. A precomputed
   "empty subtree of depth d" hash cache (21 values, computed once) turns this into
   O(real leaves × depth) — a well-scoped fix + before/after benchmark for a future night. Batch
   insertion cost and depth-vs-anonymity-set tradeoff (the original framing of this item) still
   unaddressed beyond that.

8. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   worth a pass that tries to break the circuits rather than confirm they work as documented. Note:
   RR10 (item 1) is exactly this category of finding, found by reading code, not by this kind of
   systematic pass — there may be more like it.

9. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.

10. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
    KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock).

11. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
    (`scripts/bench/browser-latency.mjs`) — add a mobile Chromium device-emulation profile.

12. **`circom --O2` adoption.** Claimed -53% constraints across all three circuits, found
    independently at least three times in the backlog (PRs #24, #40, #60) but never merged or
    independently re-verified from scratch. Now that CI can actually confirm circuit-test results
    (item 3), a good candidate for a from-scratch re-measurement on a lighter night.

13. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
    `docs/threat-model.md` RR2. Large lift — wait until the queue above settles down.

14. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer. Likely a design-only, UNMEASURED-labelled experiment.

15. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    is unmeasured.

16. **Fix `circuits`' chained `npm test` hang.** Small tooling papercut — real (non-hash-only)
    `snarkjs.groth16` calls leave the Node process alive after the test file finishes, stalling the
    `&&`-chained `npm test` script after the first file. Each file passes fine run individually.
    Low priority.
