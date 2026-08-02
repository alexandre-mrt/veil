# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance from the current baseline) is the highest-leverage next number — it moves prover time
   directly, for every circuit, on every transfer.

2. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification. **Unblocked as of 2026-08-02** —
   `docs/research/BASELINE.md` now has real per-entry-point gas
   (`shielded_transfer`: −806,292 MIST net; `compliant_transfer`: 5,015,460 MIST net, on a fresh
   local network) to diff a batched-verification design against. Note the 2026-08-02 finding that
   Groth16 verification's on-chain cost shows up in *storage* cost, not computation cost, on Sui's
   current bucketed gas model — a batching design should be evaluated against that axis specifically,
   not assumed to save computation.

3. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). Also now has a real
   `update_commitment_root` gas number (1,360,468 MIST net, 2026-08-02) as a per-update baseline.

4. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented.

5. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.
   A t-of-n threshold scheme (or even measuring the cost of a naive N-of-N re-encryption) changes
   the trust model for compliance data meaningfully and is a natural fit for the "confidential
   payroll with a t-of-n auditor board" use case named in the 2026-07-22 report.

6. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock). An
   RSA or Merkle-based revocation accumulator could make single-credential revocation cheaper
   without a full root rebuild — worth a real cost comparison, not just a design note.

7. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
   (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
   profile (`page.emulate(...)`) and compare against the desktop-headless numbers already in
   `BASELINE.md`. Good "spend an hour, get a real number" candidate for a lighter night.

8. **Real testnet/mainnet on-chain gas (congestion-adjusted reference gas price).** The 2026-08-02
   gas baseline is real Move-VM gas from a fresh local single-validator network, not real testnet/
   mainnet gas — public Sui RPC hosts (`fullnode.testnet.sui.io`, `fullnode.mainnet.sui.io`)
   remain network-policy-denied in this session (confirmed via `/root/.ccr/__agentproxy/status`:
   `403` at the CONNECT layer), even though GitHub release downloads are reachable. The moment a
   session has that access, `scripts/bench/gas-onchain.mjs` needs only a network/faucet swap to
   produce the same table against real testnet — worth checking whether local-vs-testnet reference
   gas price actually differs enough to matter.

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

13. **Fix `scripts/src/e2e-test.ts`.** Not a research experiment — a tooling gap noticed during the
    2026-08-02 gas-baseline run: its `create_pool` call is missing the required
    `epoch_duration_ms` argument (would abort against the current function signature), and its
    transfer witness has no Merkle-membership inputs (predates `transfer.circom` gaining the
    Merkle accumulator) — it was apparently never run end-to-end against a working `sui` CLI.
    `scripts/bench/gas-onchain.mjs` (2026-08-02) supersedes what it was trying to do for the
    localnet case; worth either updating it to match current source or replacing it with a
    testnet-pointed variant once testnet RPC access exists in some future session (see item 8).
