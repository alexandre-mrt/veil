# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

Re-ranked 2026-07-31 (see `LEDGER.md` same date and
[`2026-07-31-hash-constraint-attribution.md`](2026-07-31-hash-constraint-attribution.md)): a fresh
measurement showed the depth-20 Merkle path costs 4.2–5.8× what all of a circuit's identity/
nullifier Poseidon calls cost combined, and is now the empirically larger lever — promoted above
the Poseidon2 port, which also needs a new, *validated* cryptographic primitive before it can be
attempted honestly (see item 2). On-chain gas demoted, not because it's less valuable, but because
it's now confirmed **not autonomously actionable** by a code-only session — see item 3.

1. **Merkle accumulator at scale / depth vs. batched verification (10^5–10^7 commitments).**
   Promoted 2026-07-31. Now has a real per-level cost (246 non-linear / 274 linear constraints,
   from `scripts/bench/hash-constraint-attribution.mjs`) to reason with, instead of a qualitative
   "deeper is slower." Concretely: a real depth change (e.g. rebuild at depth 16, measure the
   actual proving-time delta and the anonymity-set-size cost) or a batched/recursive Merkle-proof
   scheme. Batch insertion cost and indexer throughput for reconstructing the tree client-side are
   still open. Directly relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a
   bigger anonymity set is the main lever available without redesigning the deposit flow).

2. **Verified Poseidon2 port (arity, domain-tag collisions).** Re-scoped 2026-07-31: its
   measurable half (exact non-linear-constraint contribution per Poseidon instance, and per
   Merkle level) is now **done** — see `BASELINE.md`'s "Constraint attribution" section. What
   remains is the actual swap-and-measure, which is gated on building a *verified* circom
   Poseidon2 implementation first: no maintained one is reachable on this session's allow-listed
   registries (npm was searched — nothing found). Before touching any production circuit: pull
   reference test vectors from a maintained JS implementation (`@taceo/poseidon2` or
   `@zkpassport/poseidon2`, both npm-published and BN254-targeted), hand-write a circom Poseidon2
   template, and validate its output against those vectors in isolation. Only then does a real
   swap-and-measure experiment (with the soundness argument, leakage analysis, and negative test
   the nightly loop requires for any circuit change) become honest to attempt. Likely two nights:
   build + validate, then swap + full writeup.

3. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Re-attempted 2026-07-31 and
   confirmed **blocked by session network-egress policy**, not a local toolchain gap: no prebuilt
   `sui` binary reachable (`api.github.com` returns `403` at this session's proxy; `sui` is not a
   real published crate — crates.io's `sui` is an unrelated name-squatted package), and a direct
   JSON-RPC read against a public Sui fullnode is blocked the same way (`403` on `CONNECT` to
   `fullnode.testnet.sui.io`). Demoted, not devalued: this needs the environment's network policy
   widened or a `sui` binary provisioned some other way (baked into the container image, mounted
   in) — re-attempting with the same tools each night will just reproduce the same 403s. Don't
   re-spend night-budget on this without a change on the environment side; flag it instead.

4. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 3 existing first (need a real per-verify gas number to know how much this would
   actually save) — blocked on the same network-policy issue as item 3.

5. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented.

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

9. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
   `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
   port, not a parameter change — so this should wait until items 1–2 give a clearer picture of
   what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

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
    individually. Low priority; fold into whichever future night touches `circuits/test/`.

13. **Commit or gitignore `frontend/public/circuits/withdraw_vk.json` deliberately.** Noticed
    2026-07-31: unlike `transfer_vk.json` and `compliance_vk.json` (both committed), the withdraw
    VK that `compile-withdraw.sh` copies into `frontend/public/circuits/` was never committed —
    `git status` shows it untracked after any withdraw rebuild. Not a research experiment; needs a
    real production-ceremony decision (what VK the frontend should actually ship), not a nightly
    dev-ceremony artifact committed as a side effect. Low priority; fold into whichever night runs
    a real ceremony (`circuits/scripts/ceremony.sh`) or touches `frontend/public/circuits/`.
