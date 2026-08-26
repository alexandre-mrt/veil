# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked a second time on
   2026-08-26 — this is now a confirmed **organization egress-policy denial** (403 on
   `github.com/MystenLabs/sui/releases` and on `fullnode.testnet.sui.io`'s JSON-RPC, per the proxy's
   own status endpoint), not a toolchain-availability gap. Needs either an explicit policy exception
   for one of those two hosts, or a `sui` binary reachable some other way (checked npm on
   2026-08-26 while investigating `circom`'s own npm availability — no `sui` CLI package exists
   there either). Do not re-attempt the same two hosts a third time without a policy change; if
   retried, try a *different* path (e.g. a different public fullnode host, if one is known and
   permitted) rather than repeating the denied ones.

2. **Validate the 2026-08-26 Poseidon2 domain-size projection by actually rewriting
   `withdraw.circom`.** 2026-08-26 REJECTed an off-the-shelf Poseidon2 swap based on a *computed*
   (not measured) projection that it would push `withdraw.circom` (smallest, cheapest to verify)
   across a Groth16 domain-size doubling (4,096→8,192). Actually swapping `withdraw.circom`'s three
   `Poseidon(4)` calls and one `Poseidon(2)` call to `Poseidon2Sponge` at t=8/t=3 and compiling for
   real would confirm or refute that projection methodology before it's trusted for a bigger
   decision (e.g. before committing to queue item 9, a full proof-system migration write-up, or
   before generating custom round constants per item 6 below).

3. **Custom Poseidon2 round constants for t=5 and t=6.** 2026-08-26 found the real blocker for a
   Poseidon2 win at Veil's two heaviest arities (n=4: `transfer.circom` and `withdraw.circom`'s
   commitment/nullifier hashes; n=5: `compliance.circom`'s credential leaf): `@taceo/circom-lib`
   only ships Poseidon2 round constants for t ∈ {2,3,4,8,12,16}, forcing an expensive t=8
   over-provision at exactly those two arities. Generating exact-width t=5/t=6 constants (following
   the Poseidon2 paper's generation procedure) would close the gap the 2026-08-26 report measured —
   but round-constant generation for a novel permutation instance is security-sensitive and deserves
   its own careful night with independent verification, not a quick patch. Higher-value than a
   generic Poseidon2 revisit now that the exact numbers this would need to beat are known.

5. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

6. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow).

7. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented. 2026-08-26's domain-separation check
   (`scripts/bench/poseidon2-domain-separation-check.mjs`) only sanity-checked two arbitrary tags on
   one isolated circuit — a real audit pass would check all of Veil's actual domain tags pairwise
   against the production circuits.

8. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.
   A t-of-n threshold scheme (or even measuring the cost of a naive N-of-N re-encryption) changes
   the trust model for compliance data meaningfully and is a natural fit for the "confidential
   payroll with a t-of-n auditor board" use case named in the 2026-07-22 report.

9. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock). An
   RSA or Merkle-based revocation accumulator could make single-credential revocation cheaper
   without a full root rebuild — worth a real cost comparison, not just a design note.

10. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
    (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
    profile (`page.emulate(...)`) and compare against the desktop-headless numbers already in
    `BASELINE.md`. Good "spend an hour, get a real number" candidate for a lighter night.

11. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
    `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
    port, not a parameter change — so this should wait until items 1–3 give a clearer picture of
    what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

12. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

13. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

14. **Fix `circuits`' chained `npm test` hang.** Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run: real (non-hash-only) `snarkjs.groth16`
    calls leave the Node process alive after the test file finishes printing results, which stalls
    the `&&`-chained `npm test` script after the first file. Each file passes fine run
    individually. Low priority; fold into whichever future night touches `circuits/test/`.
