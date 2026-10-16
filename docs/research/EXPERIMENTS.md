# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

**Settled:** on-chain gas per entry point — KEEP, 2026-10-16 (see `LEDGER.md`). Re-ranking that night: the gas run showed computation sits on the 1,000-unit floor for every call, so cost is storage-dominated; batched verification (old #3) lost its premise and storage reduction rose.

1. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance from the current baseline) is the highest-leverage next number — it moves prover time
   directly, for every circuit, on every transfer.

2. **Storage bytes per transfer/deposit.** NEW (2026-10-16). `shielded_transfer` nets 2,872,944 MIST and `deposit_and_register` 3,135,068 MIST on localnet, of which 1,000,000 MIST (35% / 32%) is the flat computation floor and the remaining ~65–68% is net storage. Measure what each dynamic field (nullifier, commitment, `CommitmentKey` wrappers) costs per byte and test cheaper layouts (hash-keyed `Table`, leaf batching into one object) — the number every user and every relayer actually pays, and a direct lever on D3 spam cost and the 10^5–10^7 commitment scale.

3. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
   (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
   profile (`page.emulate(...)`) and compare against the desktop-headless numbers already in
   `BASELINE.md`. Good "spend an hour, get a real number" candidate for a lighter night.

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

8. **Gas on a real network + shared-`Pool` contention.** NEW (2026-10-16). Re-run `scripts/bench/gas-localnet.mjs` against testnet/mainnet RGP once fullnode egress is permitted (`fullnode.testnet.sui.io` CONNECT was denied by the sandbox proxy), and add N parallel `shielded_transfer`s on one shared `Pool` to measure consensus-ordering latency — the likely real throughput ceiling now that gas is cheap and flat.

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

12. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** DEMOTED 2026-10-16 (was #3): the gas run measured computation at the 1,000-unit floor even for the 2-proof `compliant_transfer`, so aggregation saves ≈0 charged computation. Only revisit if storage-side batching (item 2) shows nullifier/commitment writes can be amortised by a single aggregated proof, or if Sui raises the computation floor.

13. **Sub-bucket verifier cost.** NEW (2026-10-16, low). Bound the true Groth16 `prepare_verifying_key` + verify cost below the floor via a Move unit test with a real proof under `--gas-limit` bisection; tells us how much headroom exists before verification becomes visible (relevant to a PQ or larger-circuit future).

14. **Fix `circuits`' chained `npm test` hang.** Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run: real (non-hash-only) `snarkjs.groth16`
    calls leave the Node process alive after the test file finishes printing results, which stalls
    the `&&`-chained `npm test` script after the first file. Each file passes fine run
    individually. Low priority; fold into whichever future night touches `circuits/test/`.
