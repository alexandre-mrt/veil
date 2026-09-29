# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked a *third* time
   (2026-09-28) — now precisely diagnosed rather than ambiguous: this environment's egress policy
   denies `fullnode.testnet.sui.io`, `sui-testnet.mystenlabs.com`, `static.aptoslabs.com`, and
   `github.com`'s release/API endpoints for any repo but this one (confirmed via the agent proxy's
   own status endpoint — explicit `connect_rejected` policy denials, not transient faults). This is
   now an **infrastructure change**, not something an in-session retry can fix: either add a Sui
   JSON-RPC host to the egress allowlist, or vendor a `sui` binary into the environment ahead of
   time. Do not attempt a fourth in-session workaround without one of those first — flag it to
   whoever owns this environment's network policy instead.

2. **Low-tier mobile device profile.** Cheap direct follow-up to the 2026-09-28 mobile-latency
   result (`scripts/bench/browser-latency.mjs --device --cpu-throttle`, already built): rerun with a
   slower Playwright device descriptor and a higher throttle multiplier (6-8x) to approximate a
   genuine budget Android phone, not the mid/high-tier Pixel 7 numbers already measured. Same script,
   different flags — another "spend an hour" night.

3. **Real mobile hardware proving latency.** The 2026-09-28 numbers are explicitly a CPU-throttled
   *desktop* approximation, not real hardware. Check whether a real-device provider
   (BrowserStack/Sauce Labs, or physical-device USB debugging) is reachable from this environment
   before assuming it's blocked like the Sui/GitHub hosts were — this session didn't attempt it.

4. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

5. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow).

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

9. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Demoted from #2: investigated
   2026-09-28 and found genuinely blocked, not just unattempted. No circom-level Poseidon2 template
   exists on npm (only JS/TS hashers — `poseidon2`, `@zkpassport/poseidon2`, `@taceo/poseidon2` — none
   are circom gadgets), and no reference implementation or published test vectors were reachable from
   this environment to verify a from-scratch round-constant derivation against. Re-attempt once
   `github.com` API/release access is broadened past this one repo, or a `circomlib`-compatible
   Poseidon2 template is published on npm — not by hand-deriving constants blind. Four Poseidon
   instances still dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints
   (2026-07-22 baseline: 6,470 and 6,057 respectively, vs. 1,465 for `withdraw.circom`), so this
   stays valuable, just not currently executable safely.

10. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
    `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
    port, not a parameter change — so this should wait until items 1 and 9 give a clearer picture of
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
    individually. Reconfirmed 2026-09-28 (same symptom, `prove-latency.mjs` and
    `browser-latency.mjs` both needed `timeout` to reap them despite finishing their output). Low
    priority; fold into whichever future night touches `circuits/test/`.
