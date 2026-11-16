# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

> **Loop-state note (re-ranked 2026-11-16).** `main` reflects only the 2026-07-22 night. About 115
> later nightly PRs are still open, which is why `main`'s old items #1 (gas) and #2 (Poseidon2)
> kept getting re-run. They are settled on unmerged branches:
> - on-chain gas = **KEEP** (2026-11-13, PR #119)
> - Poseidon2 swap = **REJECT** (≥15 nights, e.g. #114, #117, #118, #120)
> - mobile WASM latency = **KEEP** (2026-09-28)
>
> Don't re-run them. Before picking an item, read the newest open PR's queue as well as this one.
>
> Toolchain notes:
> - The prebuilt `sui` testnet-v1.72.1 tarball and the circom 2.2.2 binary download from github.com releases.
> - The Hermez ptau URL is 403, so generate a local pot15 (`scripts/bench/build-circuit.sh` header, about 7.5 min).
> - `scripts/bench/binding-audit.mjs` shows how to get real proofs into `sui move test` without a localnet.

0. **Value-conservation redesign (Critical, from the 2026-11-16 audit).** On `main`, `zk_withdraw` pays
   1000 TOKEN against a 100 TOKEN deposit, in two ways: a forged deposit commitment (V1), or the
   frontend's genesis commitment plus one valid transfer (V2). Honest depositors cannot withdraw.
   - **Design:** a commitment with a deposit-bound `balance` kept separate from the per-epoch
     spending counter. Bind it at deposit with a small deposit proof or an on-chain `sui::poseidon`.
     Transfer must conserve `balance` and needs a recipient output.
   - **Measure:** constraints, proving time and gas against `BASELINE.md`.
   - **Done when:** the three `binding_audit_tests::vuln_*` tests are inverted to `#[expected_failure]`.

1. **Land E7 recipient binding (`fdbc193`, 2026-09-24) and E8 compliance owner binding (#121).**
   Both are already written and tested, and both are still open on `main` (E7 was reproduced again
   on 2026-11-16 with a real proof). This needs the owner to merge. A night may rebase and
   re-verify them, but must not re-derive them.

2. **Bind or remove `txAmountHash`.** It is the transfer's public input #6 and no on-chain code
   reads it (2026-11-16 table). Either tie it to `encrypted_amount` so the auditor ciphertext is
   proven (the old 2c), or drop it and save one public input in every verification.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** The 2026-11-13 gas
   run (unmerged) found verification is about 32% of `shielded_transfer` cost and storage about 68%,
   so the upside is smaller than assumed. Do this after item 0, because the circuits will change.

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
    individually. Low priority; fold into whichever future night touches `circuits/test/`.
