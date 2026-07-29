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
   permitted). Blocked three times now (see LEDGER 2026-07-22, 2026-07-29) — 2026-07-29 confirmed
   the root cause is sandbox **network policy** (GitHub scoped to this repo only, arbitrary hosts
   including a public Sui fullnode blocked at the network layer, `crates.io` API also denies), not
   missing tooling. Re-attempting the exact same paths a fourth time isn't worth a night's budget —
   this needs either a session with a broader network allowlist, or a `sui` binary supplied ahead of
   time some other way.

2. **Cut `transfer.circom`/`compliance.circom` over to Poseidon2 Merkle hashing in production.**
   2026-07-29 validated a Merkle-only Poseidon2 swap (`transfer_hybrid.circom`,
   `compliance_hybrid.circom` — `MerkleProof2`, Poseidon2 compression mode, T=2): −4.85%/−5.18%
   constraints, −4.4%/−3.7% Node proving time, 4 real-Groth16 negative tests confirming soundness,
   zero privacy-model change. Design is proven; this item is the actual migration — regenerate and
   redeploy VKs through the existing timelocked `update_commitment_root`/`update_credential_root`
   path (`docs/threat-model.md` T3/T4/T5), reissue the frontend's shipped wasm/zkey, rerun the full
   108-case suite end-to-end against new expected hash outputs. **Do not** extend the swap to
   commitment/nullifier/leaf hashing (arity ≥3) — measured to be a large net loss (+41% to +126%
   constraints at the primitive level) because this Poseidon2 implementation isn't R1CS-optimized
   the way circomlib's Poseidon is; see the 2026-07-29 report's "Isolated primitive cost" table
   before anyone is tempted to go further than the Merkle tree.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

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
    individually. Low priority; fold into whichever future night touches `circuits/test/`. Still
    present as of 2026-07-29 (worked around per-file with `timeout`/explicit `process.exit(0)` in
    the new bench scripts and `poseidon2_hybrid.test.mjs` — not fixed at the source).

13. **Build an R1CS-optimized Poseidon2** (fold the affine layer the way circomlib's `Poseidon`
    does, instead of `@taceo/circom-lib`'s explicit per-round matrix evaluation). 2026-07-29 found
    the off-the-shelf Poseidon2 implementation loses to circomlib's Poseidon by 41–126% of
    constraints at arity ≥3, specifically because it isn't R1CS-optimized, not because Poseidon2's
    underlying algebra is worse — real effort (a from-scratch optimized circuit implementation),
    not a parameter tweak, so lower priority than actually shipping the win already found (item 2).
