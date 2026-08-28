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
   permitted). **Blocked three nights running for three different reasons** (see LEDGER
   2026-07-22, 2026-08-28) — the 2026-08-28 run confirmed the block is the outbound network
   policy itself (`fullnode.testnet.sui.io` and `github.com` both return a proxy-level 403), not a
   missing binary or a one-off tool-approval denial. Worth putting to the user directly: is a
   scoped allowlist exception for one public Sui fullnode RPC endpoint available, since
   building `sui` from source is not realistic within a single night's budget (large Rust
   workspace, no warm build cache).

2. **Poseidon2 for the arity-4/5 domain-tagged hashes (commitment, nullifier, credential leaf).**
   2026-08-28 measured and PARKed the *arity-2 Merkle-node* half of this (see
   [`2026-08-28-poseidon2-merkle-hash.md`](2026-08-28-poseidon2-merkle-hash.md)): swapping
   `MerkleProof(20)`'s node hash to a Poseidon2 compression (`@taceo/circom-lib`, audited t=2
   parameters) cuts 660 R1CS constraints from both `transfer.circom` (−4.85%) and
   `compliance.circom` (−5.18%), and ~7.1% mean Node proving time — but is not yet in production,
   pending an off-chain tree-builder migration (`frontend/src/lib/merkle-tree.ts`,
   `scripts/src/compliance-utils.ts`), a new timelocked VK, and a commitment-migration path. The
   remaining, larger piece is still open: the four `Poseidon(4)`/`Poseidon(5)` domain-tagged
   hashes together outweigh the Merkle sub-circuit's own constraint count in both circuits, and no
   audited Poseidon2 parameter set exists at those widths (`@taceo/circom-lib` and
   `@zkpassport/poseidon2` both jump from t=4 straight to t=8/12/16). Two paths worth a real
   measurement before choosing one: (a) measure the isolated per-instance cost of a single
   `Poseidon(4)`/`Poseidon(5)` call at the current baseline to see whether (b) chaining 2–3
   sequential arity-2 Poseidon2 compressions to replace one wide call is actually a net win, not
   just an assumed one.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

4. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). Now synergistic with item 2:
   if the Merkle-node hash is ever swapped to Poseidon2, a deeper tree amplifies the same
   per-level saving — worth deciding together rather than measuring twice.

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
    individually. Reproduced again on 2026-08-28 in a new bench script (worked around locally with
    an explicit `process.exit(0)` there) — confirms it's a general `snarkjs`/`circom_runtime`
    pattern, not circuit-specific. Low priority; fold into whichever future night touches
    `circuits/test/`.
