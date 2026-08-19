# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

Re-ranked 2026-08-19: item 2 (Poseidon2) is now settled **REJECT** in the ledger for the broad
"swap to Poseidon2" hypothesis — see
[`2026-08-19-poseidon2-arity-benchmark.md`](2026-08-19-poseidon2-arity-benchmark.md). It's
replaced here by a narrower follow-up (custom parameters / a better implementation), demoted
since the easy version of the win didn't pan out. Item 5 (soundness audit) and item 4 (Merkle
accumulator) move up — both are high-value and don't depend on the still-blocked gas number.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Re-attempted 2026-08-19
   with a direct JSON-RPC read against `fullnode.testnet.sui.io` (the fallback 2026-07-22 couldn't
   even attempt) — it executed and failed cleanly with `403` through this session's egress proxy,
   same as `github.com/MystenLabs/sui/releases/...` and `crates.io`. Per the proxy's own
   documentation, a 403 is an **organizational policy denial, not a transient failure** — "do not
   retry or route around it." Blocked three times now, twice for tooling reasons and once
   confirmed as standing policy. **The next attempt on this item should not be another retry — it
   should be a request for a policy exception for `fullnode.testnet.sui.io` (single read-only
   JSON-RPC host)**, since building the `sui` CLI from source was already judged impractical
   within a night's budget on 2026-07-22.

2. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented. Doesn't depend on item 1.

3. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). Doesn't depend on item 1.

4. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

5. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.
   A t-of-n threshold scheme (or even measuring the cost of a naive N-of-N re-encryption) changes
   the trust model for compliance data meaningfully and is a natural fit for the "confidential
   payroll with a t-of-n auditor board" use case named in the 2026-07-22 report.

6. **Poseidon2 for Veil's actual dominant arities — custom parameters or a better implementation.**
   Follow-up to the 2026-08-19 REJECT, not a fresh idea: that experiment measured
   `@taceo/circom-lib` 0.6.0's Poseidon2 at Veil's four call arities and found (a) no native
   parameters exist for t=5/t=6, which is exactly where `Poseidon(4)` (the commitment hash, called
   2–3× per circuit) and `Poseidon(5)` (compliance leaf) land, and (b) the t=8-padding fallback
   nearly doubles constraint count there. Two ways this could still pay off, either worth a night:
   generating real Poseidon2 round constants for t=5/t=6 (a cryptographic parameter-generation
   exercise — higher risk, needs care), or finding/writing a more R1CS-optimized Poseidon2 circom
   implementation that closes the linear-constraint gap the 2026-08-19 report traced to
   `@taceo/circom-lib`'s matrix-multiplication gadget style. Re-run
   `scripts/bench/poseidon2-prove-latency.mjs`'s pattern at production scale (embedded in a
   circuit that calls the hash multiple times, not an isolated ~500-constraint circuit) to get a
   proving-time number the isolated benchmark couldn't produce reliably.

7. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock). An
   RSA or Merkle-based revocation accumulator could make single-credential revocation cheaper
   without a full root rebuild — worth a real cost comparison, not just a design note.

8. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
   (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
   profile (`page.emulate(...)`) and compare against the desktop-headless numbers already in
   `BASELINE.md`. Good "spend an hour, get a real number" candidate for a lighter night.

9. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
   `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
   port, not a parameter change — so this should wait until the constraint-count picture from
   items 2 and 6 settles before committing a multi-night effort to a proof-system swap.

10. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

11. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

12. **Fix `circuits`' chained `npm test` hang.** Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run: real (non-hash-only) `snarkjs.groth16`
    calls leave the Node process alive after the test file finishes printing results, which stalls
    the `&&`-chained `npm test` script after the first file. Each file passes fine run
    individually. Low priority; fold into whichever future night touches `circuits/test/`. (The
    2026-08-19 benchmark script hit the identical symptom and worked around it with an explicit
    `process.exit(0)` after printing — see `scripts/bench/poseidon2-prove-latency.mjs`; the same
    fix would resolve this item for the main `circuits/test/*.test.mjs` files too.)
