# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Needs a working `sui` CLI
   (prebuilt binary, or a from-source build budgeted across more than one night) or explicit
   permission to make direct JSON-RPC reads against the already-deployed testnet package
   (`README.md` has real package/pool/config IDs — `suix_queryTransactionBlocks` against a public
   fullnode could recover real historical gas without the CLI at all, if that network call is
   permitted). Blocked three times running now for the same structural reason — see LEDGER
   2026-07-22 and 2026-09-25: this session's egress policy denies `github.com`,
   `static.crates.io`, and every public Sui RPC/explorer host tried (`fullnode.testnet.sui.io`,
   `api.testnet.sui.io`, `rpc.ankr.com`, `sui-testnet.blockvision.org`,
   `sui-testnet-rpc.publicnode.com`, `sui-testnet.nodeinfra.com`, `suiscan.xyz`, `suivision.xyz`),
   confirmed via the proxy status endpoint as an organization-policy `403`, not a transient or
   retryable failure. **This one is not unblockable from inside the loop** — it needs either a
   broader host allowlist from whoever administers the sandbox, or gas artifacts made reachable
   through an already-allowed channel (npm, or vendored into the repo). Keep at the top as a
   standing reminder to check whether the policy has changed, but stop re-attempting the same set
   of hosts each night without new information.

2. **Poseidon2 for the Merkle-path hasher specifically.** Re-ranked and narrowed by the
   2026-09-25 run: isolating each Poseidon instance showed the single depth-20 `MerkleProof`
   component (20× `Poseidon(2)`) is **76-81%** of `transfer.circom`'s and `compliance.circom`'s
   non-linear constraints on its own (4,920 of 6,470 / 6,057) — far more than the three-or-fewer
   top-level identity/nullifier `Poseidon(3..5)` calls a swap targeting "Poseidon" broadly would
   naturally focus on. A Poseidon2 migration scoped to just `templates/merkle_proof.circom`'s
   internal hasher would likely capture most of the available win at a fraction of the audit
   surface of a protocol-wide swap. Blocked on the same root cause as item 1's toolchain gap, one
   layer down: no Poseidon2 circom implementation is reachable through this session's allowlist
   (checked `poseidon2-circom`, `circom-poseidon2`, `@zk-kit/circuits`, and `circomlib`'s latest npm
   release — none ship one), and hand-deriving Poseidon2's round constants without a reachable
   reference to check them against was explicitly rejected as unverifiable. Needs either network
   access to a canonical reference (paper + test vectors) or a way to install one through an
   already-allowed registry. See `2026-09-25-poseidon-merkle-constraint-isolation.md`.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

4. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). The 2026-09-25 run derived
   the per-level constraint cost (246 non-linear constraints/level, measured via
   `scripts/bench/poseidon-isolation.mjs`) — e.g. depth 20 → 24 (1.05M → 16.7M-leaf anonymity set)
   costs +984 non-linear constraints (~15% growth on `transfer.circom`'s Merkle-proof cost alone);
   proving-time impact of that delta is still unmeasured and would be this item's first result.

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
