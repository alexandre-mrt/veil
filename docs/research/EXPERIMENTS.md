# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

**Status note (2026-08-30):** items #1 and #2 are both currently **BLOCKED on human action**
(GitHub access scoped to this one repo, and a network-policy block on blockchain RPC hosts — see
each item). They stay ranked first because they're genuinely the highest-value items once unblocked,
but a run should not re-spend a whole night rediscovering the same wall — confirm nothing has changed
(a quick check, not a full re-investigation) and move to #4, #5, or #8, all fully actionable with the
current toolchain.

1. **Poseidon2: the actual swap, measured.** 2026-08-30 answered "how much could this ever save" —
   `transfer.circom` is 93.1% Poseidon, `compliance.circom` 94.3%, `withdraw.circom` 78.0%
   (`scripts/bench/constraint-breakdown.mjs`, exact reconciliation against a fresh compile). What's
   still missing is the swap itself: a *verified* Poseidon2 `.circom` gadget (round constants,
   external/internal round structure, linear layer — not a from-memory reimplementation) ported into
   at least `transfer.circom`, with a real before/after constraint-count and proving-time delta.
   Currently **blocked on the same root cause as item #2 below**: no verified Poseidon2 circom source
   is reachable from a GitHub-scoped session. If GitHub access to a Poseidon2 reference repo (e.g.
   `HorizenLabs/poseidon2`) is granted, or a peer-reviewed `.circom` gadget becomes available another
   way, this becomes the single highest-leverage night left in the queue — it moves prover time
   directly, for every circuit, on every transfer, and the ceiling is now known precisely enough to
   tell in advance whether it's worth doing.

2. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. As of 2026-08-30, confirmed
   **structurally blocked**, not a toolchain gap: this session's GitHub access is scoped to
   `alexandre-mrt/veil` only, so `sui` CLI release binaries (served via `github.com/MystenLabs/sui/...`)
   are gated at 403 by the access layer itself (not a network failure) — `add_repo` access to
   `MystenLabs/sui` would unblock it. Separately, direct JSON-RPC to *six* different Sui fullnode
   providers (`fullnode.testnet.sui.io`, `fullnode.mainnet.sui.io`, `sui-testnet-rpc.publicnode.com`,
   `sui-testnet.blockvision.org`, `rpc.ankr.com`, `explorer-rpc.testnet.sui.io`) all got an identical
   `connect_rejected`/403 network-policy denial — reads as a category-level block on blockchain RPC
   hosts, not a per-provider issue. **Demoted below item #1** because, unlike the Poseidon2 gap, no
   in-session workaround exists at all here — this needs a human to either grant the GitHub access or
   add a network-policy exception before another night's attempt would produce anything but the same
   result. Re-promote to #1 immediately once either changes.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 2 (gas) existing first (need a real per-verify gas number to know how much this
   would actually save).

4. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow).

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
   **Likely to hit the same GitHub-scoping wall as item #1's Poseidon2 gadget** (2026-08-30): PLONK/
   Halo2/Nova-folding tooling for circom-style circuits is distributed almost entirely as GitHub
   source (e.g. `zkonduit`, `microsoft/Nova`, `privacy-scaling-explorations/halo2`), not as npm/cargo
   packages. Worth a five-minute reachability check at the start of whichever night takes this on,
   before committing the multi-night budget.

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
