# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

0. **Before picking anything below: confirm last night's PR actually merged.** As of 2026-09-12,
   `main` had gone 52 days without merging a single research finding — 45+ open PRs (#10–#59),
   almost all independent rediscoveries of items that look "unsettled" only because nothing ever
   landed to update this file. Root cause (a broken CI action pin) was diagnosed once on 2026-09-06
   (PR #55) and *still* took until 2026-09-12 to actually apply, because the fix itself sat
   unmerged too. If you're reading this and the most recent LEDGER row is more than ~2 nights old,
   **stop and say so** — loudly, as this run's entire deliverable — rather than opening PR #61 with
   an 11th duplicate of whatever's on top below. Check `docs/research/2026-09-12-ci-backlog-and-O2-optimization.md`
   for the full audit and what's already been triaged.

1. **Fix `RR10` — `zk_withdraw` doesn't bind `recipient` on-chain (Critical, fund theft).**
   Found 2026-09-11 (PR #59, unmerged), confirmed independently against `main` on 2026-09-12:
   `contracts/sources/pool.move:571-632` extracts `recipientHash` from the withdraw proof's public
   inputs but never checks it against the `recipient` address parameter the caller supplies. A
   valid withdrawal's `(proof_bytes, public_inputs_bytes)` verifies identically if resubmitted with
   a different `recipient` — a front-runner or relayer can steal the payout while the real sender's
   nullifier gets spent. See `docs/threat-model.md` RR10. Needs: a decided Sui-address→field-element
   encoding convention, an on-chain check (`recipientHash == hash(recipient)` using whatever
   Poseidon-in-Move infrastructure the verifier module already has, or a documented alternative),
   a soundness argument, and a negative test proving a substituted recipient is rejected. This is
   now the single highest-priority item in this file — real funds move through this function today.

2. **On-chain gas per entry point — largely SETTLED, one gap left.** PR #59 (2026-09-11) measured
   all 10 entry points on a local Sui network with a real prebuilt `sui` 1.79.0 CLI (downloaded
   directly from GitHub releases — the fix that had eluded every earlier attempt, including this
   session's, was simply *not* going through `crates.io` or a from-source build). Headline finding:
   computation gas is flat (the minimum bucket) regardless of circuit size — storage/dynamic-field
   churn on the shared `Pool` object dominates, not proof verification. `BASELINE.md` updated in
   that PR. **Gap:** those numbers predate item 1's `--O2` adoption (2026-09-12) and item 0's
   `RR10` fix (not yet done) — worth a fast re-run once both land, to confirm computation gas is
   still flat post-`--O2` (storage gas won't move; computation gas for verification might, slightly,
   with a smaller zkey) and to add whatever gas the `RR10` fix's new on-chain check costs.

3. **Poseidon2 vs current Poseidon — SETTLED REJECT, independently, many times over.** At minimum
   10 separate nights (PRs #18, #19, #21, #23–#30, #32, #34, #36, #37, #39–#42, #44–#47, #50, #53,
   #57, plus this session's own 2026-09-09 report) reached REJECT on some framing of this swap.
   **Do not re-run any version of "swap Poseidon for Poseidon2" again** without first reading
   `docs/research/2026-09-12-ci-backlog-and-O2-optimization.md`'s open question #4: at least three
   independent measurements of the *same* Merkle-hasher-only swap (this session's 2026-09-09 report,
   PR #42's 2026-08-24 report, and PR #18/#46) disagree in *sign* (a small win vs. a real
   regression) depending on which circom template implementation was used. That contradiction —
   not a fourth attempt at the swap itself — is the one open thread here, and the newly-landed
   `--O2` flag (item 1 above) makes it directly testable: re-compile PR #42's exact
   `@taceo/circom-lib`-based template under `--O2` and see whether its measured regression
   survives. If `--O2` erases it, that confirms the regression was a circom-encoding artifact, not
   a property of Poseidon2 itself, and definitively closes this question.

4. **Circuit-gadget constraint attribution — SETTLED KEEP.** PR #58 (2026-09-10, `--O1`-era
   numbers) and several earlier nights (#20, #23, #26, #27, #33, #35, #38, #43, #48, #52, #54)
   independently confirmed: the 20-level Merkle path (`Poseidon(2)` × 20), not the four
   domain-tagged Poseidon calls the README/2026-07-22 baseline emphasized, dominates non-linear
   constraint count (76-81% in `transfer`/`compliance`). Re-run once under `--O2` if the exact
   post-`--O2` gadget breakdown becomes load-bearing for a future decision; not urgent on its own.

5. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification. PR #59's finding that computation gas is
   already flat/minimum-bucket regardless of circuit size is relevant context: batching saves the
   *count* of verifications, not their per-call cost, and storage gas (the actual dominant cost per
   PR #59) is per-commitment/per-nullifier regardless of how many proofs got batched into one
   verify call — re-scope this experiment around *storage*-gas amortization, not verification-gas
   amortization, given what's now known.

6. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability).

7. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' domain tags, proof malleability. RR10 (item 1) is exactly the kind of
   finding this audit is meant to surface systematically — worth treating as evidence there may be
   more, not a one-off.

8. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.

9. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock).

10. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness.

11. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
    `docs/threat-model.md` RR2. Large lift — wait until items above give a clearer picture.

12. **Post-quantum exposure.** Design-only, UNMEASURED-labelled experiment.

13. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — unmeasured.

14. **Fix `circuits`' chained `npm test` hang / `snarkjs` lingering-handle issue.** Confirmed to
    also stall `snarkjs groth16 setup`/`zkey contribute` piped through `tail` (2026-09-09). Every
    script this loop writes that drives `snarkjs` should call `process.exit(0)` explicitly at the
    end — several already do; worth a sweep to check all of them do.

15. **Poseidon2 for the 4-input domain-tag hashers (`t=5`, no published parameter set).** Low
    priority: item 3 above already found the *linear-layer* argument for Poseidon2 doesn't help in
    R1CS; any remaining case rests on round-count alone, cheap to compute before committing a night.

16. **Lower-round Merkle-path hashing / wider-arity trees.** Speculative: does an arity-3 (or
    wider) Merkle tree cost fewer total constraints than depth-20 binary, independent of hash
    choice? Needs a real constraint-count comparison, not a guess.

17. **Triage the closable PRs.** Once items 1-3 above are confirmed settled on `main`, most of the
    45 open PRs this file used to not know about are safe to close as superseded duplicates — a
    human pass (or a future night with explicit permission to close PRs), not automatic. At least
    two look like they might contain something distinct worth pulling first: PR #49
    ("merkle-zero-hash-pruning") and PR #19/#18/#46 (three more Merkle-hasher measurements feeding
    into item 3's sign-discrepancy question).
