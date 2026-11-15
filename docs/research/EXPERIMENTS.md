# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

> **Loop-state note (2026-11-15).** `main` only reflects the 2026-07-22 night: ~110 later
> nightly PRs were never merged, so each night started from this stale queue and re-ran items that
> other branches had already settled. Settled elsewhere (see the 2026-11-15 report, §"Why this
> experiment"): **on-chain gas = KEEP** (2026-11-13: `shielded_transfer` 3,116,144 MIST net,
> localnet, real proofs); **Poseidon2 swap = REJECT** (≥15 nights, e.g. 2026-11-08/11/12/14);
> **mobile WASM latency = KEEP** (2026-09-28); **Merkle zero-hash pruning = KEEP** (2026-08-31).
> Do not re-run them until those branches are merged or closed. Toolchain note: the prebuilt
> `sui` 1.72.1 tarball and circom 2.2.2 binary both download from github.com releases; the Hermez
> ptau URL is 403, so generate a local dev pot15 (`scripts/bench/build-circuit.sh` header).

1. **Public-input binding audit across every entry point.** E7 (recipient) and E8 (compliance
   owner, fixed 2026-11-15) are the same bug class: a public input is proven in-circuit but never
   compared on-chain with the value it's meant to bind. Make a mechanical table of every public input of
   `transfer`/`withdraw`/`compliance` against the Move check that consumes it, with one negative
   Move test per row. Cheap, and so far it has found every real vulnerability. Top priority.

2. **Recipient binding (E7): land `fdbc193`.** Critical, open on `main` since at least 2026-09-21.
   The fix (on-chain `sui::poseidon` recomputation, no circuit change) was written and tested on
   2026-09-24. Owner action: merge. If it is still unmerged, a night may rebase and re-verify it,
   but must not re-derive it from scratch.

2b. **Single combined transfer+compliance circuit (2026-11-15 open question).** Saves one
   `sui::groth16` verify per compliant transfer and makes the owner binding structural. Measure
   constraints, proving time and gas against two separate proofs.

2c. **Bind `encrypted_amount` (auditor ciphertext) inside a proof.** Today it is only
   length-checked on-chain, so a prover can attach an arbitrary blob and the auditor gets nothing.

2d. **`compliant_transfer` gas with the owner binding.** Re-run the 2026-11-13 localnet harness.
   Expected unchanged (O(1) byte compare before verification), currently UNMEASURED.

2e. **Transfer linkability: `oldCommitment` is public (2026-11-14 finding, unmerged branch).**
   `pool.move` removes the spent commitment by key, so deposit → transfers → withdrawal link by
   byte equality, and the Merkle membership proof (C0) buys no anonymity while costing most of
   transfer proving time. Read the 2026-11-14 report before starting.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   The 2026-11-13 gas run (unmerged) found verification is ~32% of `shielded_transfer` cost
   (computation at the minimum bucket) and storage ~68%, so the upside is smaller than assumed.

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
