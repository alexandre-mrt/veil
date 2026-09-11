# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Fix: `zk_withdraw` never checks `recipient` against the proof's `recipientHash`.** Found
   2026-09-11 while building the on-chain gas harness, not by looking for it —
   `contracts/sources/pool.move:571-632` extracts `commitment_bytes`, `withdraw_amount`, and
   `nullifier` from the proof's public inputs and checks each against on-chain state, but never
   extracts bytes `96..128` (`recipientHash`) at all, despite a comment claiming "front-running is
   prevented: changing recipient invalidates the Groth16 proof." It doesn't: the proof verifies
   that `public_inputs_bytes` (a fixed blob) is valid, which says nothing about the separate
   `recipient: address` argument the same transaction carries. A valid `(proof_bytes,
   public_inputs_bytes)` pair for a withdrawal to address A verifies identically if resubmitted with
   `recipient = B` — a front-runner or a buggy/malicious relayer can copy a pending `zk_withdraw`
   verbatim, swap in their own address, and steal the payout; the original submitter's nullifier is
   now spent and their real transaction reverts. This is fund theft, not a privacy nuance. Promoted
   above the Poseidon2 item because it's a live vulnerability, not an optimization — ranking
   "moves a number" second to "someone can steal money today" would be backwards. Full mechanism:
   `2026-09-11-onchain-gas-baseline.md` Open questions #1; tracked as `docs/threat-model.md` RR10.
   The fix needs, in the same PR: a decided Sui-address-to-BN254-field-element convention (none
   exists anywhere in this repo yet — see Open questions #2 in the same report), the on-chain
   `assert!(Poseidon(8, recipient) == recipientHash)` check itself, a soundness argument for why
   that closes the gap, and a negative test proving a swapped-recipient replay is rejected.

2. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance from the current baseline) is the highest-leverage next *performance* number — it moves
   prover time directly, for every circuit, on every transfer. Note from 2026-09-11: this delta
   will not show up in on-chain gas at all (verification cost is flat regardless of circuit size —
   see `BASELINE.md`'s gas table) — it only moves prover time, which is still very much worth
   moving, just budget the pitch accordingly.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Unblocked as of 2026-09-11: `BASELINE.md` now has a real `shielded_transfer` gas number
   (2,872,944 net MIST, of which only 1,000,000 is computation) to diff a batched-verification
   number against — and that same baseline shows storage/dynamic-field churn, not verification
   computation, dominates the cost, which changes what batching would actually need to save to be
   worth it.

4. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow).

5. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented. Item 1 above is exactly the kind of finding
   this audit is meant to surface systematically rather than by accident — do this one next and
   expect more like it.

6. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.
   A t-of-n threshold scheme (or even measuring the cost of a naive N-of-N re-encryption) changes
   the trust model for compliance data meaningfully and is a natural fit for the "confidential
   payroll with a t-of-n auditor board" use case named in the 2026-07-22 report.

7. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock). An
   RSA or Merkle-based revocation accumulator could make single-credential revocation cheaper
   without a full root rebuild — worth a real cost comparison, not just a design note.

8. **Compliant-transfer (dual-proof) gas cost.** The one entry point 2026-09-11's on-chain gas
   harness didn't reach — needs a `ComplianceConfig` and a seeded credential Merkle tree in
   addition to what that run already set up. The harness (`scripts/bench/onchain-gas.ts`) and the
   local-network path both already exist; this is now a cheap extension, not a fresh toolchain
   problem.

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

13. **Gas under shared-object contention.** 2026-09-11's gas numbers are for uncontended,
    sequential calls against the pool's single shared `Pool` object only. What happens to
    `computationCost` (congestion-priced consensus scheduling) under many concurrent callers is a
    different, scalability-relevant measurement the same harness doesn't answer.

14. **Fix dead `pot15` ptau URLs in `circuits/scripts/compile*.sh`.** Both hardcoded mirrors
    (`storage.googleapis.com/zkevm/ptau/...` and the Hermez S3 mirror `ceremony.sh` also assumes)
    now return real `AccessDenied` responses — not a sandbox network-policy block, the objects
    themselves appear to no longer be publicly readable. 2026-09-11 worked around this by
    generating a fresh local pot15 (`snarkjs powersoftau new` → `contribute` → `prepare phase2`,
    same dev-only ceremony class the scripts already produce), but a clean checkout of this repo
    cannot currently run `compile.sh` as documented. Fix: either vendor a small pot15 file or have
    the scripts generate one locally by default, falling back to a URL only if one is configured.

15. **Fix `circuits`' chained `npm test` hang.** Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run: real (non-hash-only) `snarkjs.groth16`
    calls leave the Node process alive after the test file finishes printing results, which stalls
    the `&&`-chained `npm test` script after the first file. Each file passes fine run
    individually. Low priority; fold into whichever future night touches `circuits/test/`.

16. **Pin a canonical Sui-address-to-BN254-field-element convention.** No such mapping exists
    anywhere in this repo today — `circuits/test/withdraw.test.mjs` and the 2026-09-11 gas harness
    both use an arbitrary constant for the withdraw circuit's `recipient` signal rather than a real
    address, for lack of one to reuse. A prerequisite for item 1's fix, not independently valuable,
    but worth stating as its own line so it doesn't get silently invented differently twice.
