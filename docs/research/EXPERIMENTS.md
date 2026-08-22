# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

**Re-ranked 2026-08-22.** Item 2 (Poseidon2 vs current Poseidon) is now settled — REJECT for the
swap itself (see `LEDGER.md`) — and dropped from the active queue below; item 9 (Poseidon2 at t=5/
t=6) is new and captures the specific, narrower follow-up that's still open. Everything else moved
up one slot. On-chain gas (item 1) is unchanged at the top — blocked a third time, now with a
precise root cause (see its entry) rather than a repeat of the same generic blocker.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis, blocked three nights running
   now (2026-07-22, 2026-08-22) for what turns out to be the same underlying cause each time: this
   session's egress policy denies both `github.com` release-asset downloads (for a prebuilt `sui`
   binary) and direct JSON-RPC to `fullnode.testnet.sui.io` (`403` on both, confirmed via the proxy
   status endpoint) — but *permits* `git clone`/`ls-remote` against `github.com` itself, which is
   how `circom` gets built from source each session. `sui` has no crates.io package (checked
   2026-08-22) and building the full Sui workspace from source is still judged impractical within
   one night's budget. Next real options: (a) ask whoever configures this session's network policy
   to allowlist read-only RPC against `fullnode.testnet.sui.io` specifically — needs no `sui` CLI at
   all; (b) a from-source `sui` build explicitly budgeted across 2+ nights; (c) re-check crates.io
   periodically in case a `sui`-equivalent gets published.

2. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save). Also now has a concrete secondary question from 2026-08-22 worth answering in the
   same pass: `--O2` cut total constraints ~53% but Node proving time only ~23% for the two
   Merkle-heavy circuits — splitting `snarkjs.wtns.calculate` from `groth16.prove` in a benchmark
   would show whether witness generation or the actual Groth16 MSM/FFT is proving time's real
   bottleneck at this circuit size, which changes how much batching would actually help.

3. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). Now cheaper to prototype than
   before 2026-08-22: `circuits/experiments/poseidon2/bench/merkle20_poseidon.circom` is a ready-made
   isolated depth-20 Merkle-path microbenchmark circuit to fork for a depth sweep.

4. **Poseidon2 at t=5/t=6 — the majority of Veil's hash call-sites.** The narrower, harder version
   of the settled 2026-08-22 experiment. `Poseidon(4)` (t=5) is the *majority* hash arity by
   call-site count — both commitments and both nullifiers in `transfer.circom`/`withdraw.circom` —
   and `Poseidon(5)` (t=6) is the credential leaf in `compliance.circom`; neither has a verified
   BN254 Poseidon2 parameterization in any package checked so far (`@taceo/circom-lib`,
   `@taceo/poseidon2`, `@zkpassport/poseidon2`, `@zk-kit/circuits`, `poseidon-lite`,
   `poseidon-bls12381-circom`). Two paths, either needing independent review before touching a
   commitment/nullifier hash: (a) run the HorizenLabs reference sage generator
   (`github.com/HorizenLabs/poseidon2`) and get the output cross-checked against a second source;
   (b) the domain-tag-via-capacity redesign below, which sidesteps the t=5 gap entirely by dropping
   the arity to t=4. Given 2026-08-22's result (no win even where Poseidon2 *was* triable), this is
   lower urgency than it was — worth revisiting only if a verified parameter set surfaces cheaply.

5. **Domain-tag-via-capacity redesign.** Moving the domain-separation tag into the sponge's
   capacity/IV element instead of consuming a rate slot (a technique the Poseidon2 paper itself
   endorses) would drop every current t=5 commitment/nullifier hash to a fully-supported t=4 —
   sidestepping item 4's parameter-set gap entirely. This is a real preimage-layout change to every
   commitment and nullifier in the protocol, so it needs its own domain-separation soundness
   argument (not just "it compiles"), not a footnote on a hash-swap experiment.

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

9. **Mobile WASM proving latency, and re-measuring browser proving time at `--O2`.** Two cheap
   extensions of the existing browser harness (`scripts/bench/browser-latency.mjs`): (a) it was
   never re-run against the new `--O2` `circuits/build{,-withdraw,-compliance}/` artifacts adopted
   2026-08-22 — same script, no code changes, just re-run; (b) add a mobile Chromium
   device-emulation profile (`page.emulate(...)`) and compare against desktop-headless. Good
   "spend an hour, get a real number" candidate for a lighter night.

10. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
    `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
    port, not a parameter change — so this should wait until items 1–2 give a clearer picture of
    what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

11. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

12. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

13. **`frontend/public/circuits/transfer_vk.json` / `compliance_vk.json` staleness.** Only
    `circuits/scripts/compile-withdraw.sh` auto-copies its `_vk.json` to
    `frontend/public/circuits/`; `compile.sh` and `compile-compliance.sh` don't, so those two files
    are now stale relative to the `--O2` `circuits/build/` adopted 2026-08-22 (noticed while running
    that experiment). Small tooling fix — add the same copy step to the other two scripts, or
    centralize it — fold into whichever future night touches `circuits/scripts/`.

14. **Fix `circuits`' chained `npm test` hang.** Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run, unchanged by 2026-08-22 (still exists at
    `--O2`): real (non-hash-only) `snarkjs.groth16` calls leave the Node process alive after the
    test file finishes printing results, which stalls the `&&`-chained `npm test` script after the
    first file. Each file passes fine run individually. Low priority; fold into whichever future
    night touches `circuits/test/`.
