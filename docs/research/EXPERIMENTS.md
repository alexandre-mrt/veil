# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Re-confirmed **BLOCKED**
   2026-09-07, now with clean, attributable evidence instead of an ambiguous denial: direct JSON-RPC
   to `fullnode.testnet.sui.io` is refused by this session's egress policy (`connect_rejected`,
   confirmed via the proxy status endpoint — an explicit policy denial); `sui` CLI access is blocked
   because this session's GitHub access is scoped to `alexandre-mrt/veil` only (`git clone` itself
   works fine — confirmed by cloning `iden3/circom` for tonight's toolchain — the blocker is
   `MystenLabs/sui` specifically being out of scope, plus the from-source build still being a
   multi-hour job even if it weren't). **This is now an environment-configuration blocker, not
   something another night's attempt can fix** — worth flagging to whoever configures this loop's
   sandbox (allow `fullnode.testnet.sui.io` egress, or widen GitHub scope, or provide a
   prebuilt `sui` binary some other way) rather than re-attempting the same two routes a fourth time.
   Blocked three nights running for the same underlying reason; see LEDGER 2026-07-22 and 2026-09-07.

2. **Fix the ptau-hosting blocker (new, 2026-09-07).** `circuits/scripts/compile.sh` and
   `compile-{withdraw,compliance}.sh` all depend on
   `storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau`, which now returns `403
   AccessDenied` from GCS itself (confirmed reproducible; two alternate mirrors also failed — see
   the 2026-09-07 report). `BASELINE.md`'s existing proving-time numbers are unaffected (measured
   2026-07-22 while the bucket worked), but nobody can currently reproduce them, no full-proof-mode
   circuit test run is possible, and this blocks item 3 below and the mobile-latency item (9) until
   fixed. Options: find a mirror that isn't also access-denied, vendor a small pot-15 ptau file some
   other way, or generate a fresh dev-only ptau locally (`snarkjs powersoftau new` + a couple of
   local contributions — slower, ~2^15 constraints is small enough this should be minutes not hours,
   and it has no external dependency at all). Promoted above the Poseidon2 items because it blocks
   validating any of their proving-time claims.

3. **Poseidon2 arity-2 vs current Poseidon(2) — narrowed by the 2026-09-07 decomposition.**
   The constraint decomposition (`2026-09-07-poseidon-constraint-decomposition.md`, folded into
   `BASELINE.md`) found Poseidon is 89–98% of every circuit's constraint budget, and — critically —
   that the depth-20 Merkle path (pure `Poseidon(2)` calls) alone is 76–82% of
   `transfer.circom`/`compliance.circom`'s total, roughly 3.7–5x the combined cost of every other
   Poseidon instance (arities 3/4/5) in the same circuit. That reframes this experiment: don't port
   all four arities — vendor or write a Poseidon2 **arity-2** circom template first, probe it exactly
   like tonight's `poseidon2.circom` (243 non-linear / 274 linear / 517 total per instance is the
   number to beat), and get a real predicted saving before touching anything else. The other three
   arities are individually only 5–7% of budget each and are a distant second priority. Blocked on
   item 2 above for validating any resulting proving-time claim end-to-end.

4. **Merkle accumulator at scale (10^5–10^7 commitments).** Now has a real, measured per-level cost
   (517 R1CS constraints/level, from the 2026-09-07 decomposition) instead of a guess — e.g. depth 20
   → depth 24 (16x bigger anonymity set) costs exactly `4 × 517 = 2,068` more constraints (+15.2% on
   `transfer.circom`). Batch insertion cost and indexer throughput for reconstructing the tree
   client-side are still unmeasured. Directly relevant to `docs/threat-model.md` RR5
   (deposit-commitment linkability).

5. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save) — still blocked on the same item 1 dependency as before.

6. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented.

7. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.
   A t-of-n threshold scheme (or even measuring the cost of a naive N-of-N re-encryption) changes
   the trust model for compliance data meaningfully and is a natural fit for the "confidential
   payroll with a t-of-n auditor board" use case named in the 2026-07-22 report.

8. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock). An
   RSA or Merkle-based revocation accumulator could make single-credential revocation cheaper
   without a full root rebuild — worth a real cost comparison, not just a design note.

9. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
   (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
   profile (`page.emulate(...)`) and compare against the desktop-headless numbers already in
   `BASELINE.md`. Blocked on item 2 (needs a zkey to prove with) until the ptau hosting issue is
   fixed. Good "spend an hour, get a real number" candidate once unblocked.

10. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
    `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
    port, not a parameter change — so this should wait until items 3–4 give a clearer picture of
    what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

11. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

12. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

13. **CI is red on `main` for two of four jobs (new, found 2026-09-07 while opening the
    decomposition PR).** `Frontend (vitest + biome + tsc)` and `Proof converter + compliance utils`
    both fail at job setup — `Unable to resolve action oven-sh/setup-bun@735343b6...`, the pinned
    commit SHA in `.github/workflows/ci.yml` can no longer be resolved by GitHub Actions. Confirmed
    failing identically on `main`'s own HEAD run (not something #56 introduced). Proposed fix posted
    on PR #56: swap the two `oven-sh/setup-bun@<sha>` lines for `oven-sh/setup-bun@v2`. Not pushed
    there since `ci.yml` is outside that PR's scope — a small, standalone fix PR the next night (or
    a human) can land in one commit. Worth doing before any future PR needs green frontend/script CI
    to merge.

14. **Fix `circuits`' chained `npm test` hang.** Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run: real (non-hash-only) `snarkjs.groth16`
    calls leave the Node process alive after the test file finishes printing results, which stalls
    the `&&`-chained `npm test` script after the first file. Each file passes fine run
    individually. Low priority; fold into whichever future night touches `circuits/test/`.

15. **`scripts/src/test-compliance-utils.ts` is slow (multiple minutes).** Noticed 2026-09-07: its
    depth-20 `buildMerkleTree` tests (`section("buildMerkleTree — depth 20")` and the depth-20
    `getMerkleProof` test) pad the leaf layer to the full `2^20` width and hash the whole tree with
    JS-side `circomlibjs` Poseidon — roughly 2^20 Poseidon calls, taking minutes where the rest of
    the 67-test suite is near-instant. Not a correctness issue (it passed, 67/67), just a slow test;
    worth either accepting a sparse/partial tree representation in `buildMerkleTree` for depth-20
    tests specifically, or moving the full-width case behind a slower/optional test tag. Low
    priority tooling papercut, same tier as item 13.
