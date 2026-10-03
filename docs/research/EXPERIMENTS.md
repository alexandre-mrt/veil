# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. **Toolchain recipe (ephemeral container — rebuild each night that needs it):** `sui` has no reachable
prebuilt binary and public RPCs/GCS are network-denied, but `git clone` works: `git clone --depth 1
https://github.com/MystenLabs/sui` then `cargo build --release -p sui --bin sui` (≈48 min on 4 cores;
`-p sui-move` ≈19 min is enough for `sui-move test -e testnet`). circom: build `iden3/circom` v2.2.2.
Powers of Tau: Hermez download is denied — generate pot15 locally with `snarkjs powersoftau`.
Start a net: `sui start --force-regenesis --with-faucet` (gRPC on :9000; JSON-RPC is gone).

Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** Four Poseidon instances
   dominate `transfer.circom`'s and `compliance.circom`'s non-linear constraints (2026-07-22
   baseline: 6,470 and 6,057 non-linear constraints respectively, vs. 1,465 for the
   Poseidon-light `withdraw.circom`). A measured constraint-count and proving-time delta from
   swapping to Poseidon2 (or re-deriving the exact non-linear-constraint contribution per Poseidon
   instance from the current baseline) is the highest-leverage next number — it moves prover time
   directly, for every circuit, on every transfer.


2. **Net storage per transfer (~1.75M of ~2.75M MIST).** 2026-10-03 baseline: computation sits at the
   1,000-unit floor for every entry point, so the bill is storage — the nullifier and new-commitment
   dynamic fields persist forever. Split the two, then price an epoch-batched / Merkle-committed
   nullifier set (one object per epoch) against today's per-nullifier dynamic field. Moves the number
   users actually pay.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Unblocked by 2026-10-03: verify costs 185–270 raw units, 2 verifications per PTB (3 with a prepared VK)
   are free inside the 1,000-unit floor. Still to measure: k *real* `shielded_transfer`s in one PTB, and
   shared-object contention on `Pool` under concurrent PTBs (multi-client localnet). Also: confirm the
   243,175 MIST net-fee gap between identical transfers is the lazily applied pending root, and re-measure
   `create_pool` with a finer pad (see 2026-10-03 open questions).


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

*Removed 2026-10-03:* item "Fix `circuits`' chained `npm test` hang" — already fixed on `main` by #17 ("exit test runners explicitly"); the full `npm test` chain now prints all three result lines. Item "On-chain gas per entry point" settled — see LEDGER 2026-10-03; re-ranking: Poseidon2 now #1 (prover time), new storage-per-transfer item #2 because the gas baseline showed storage, not verification, is what users pay.
