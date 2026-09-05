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
   permitted). Blocked three times now (2026-07-22, 2026-09-05) for the same class of reason: this
   sandbox's network policy denies `github.com`, `static.crates.io`, and a direct
   `fullnode.testnet.sui.io` JSON-RPC read, all with a `403`. This is not a tooling gap this loop
   can code its way around — it may need a human to explicitly allowlist
   `fullnode.testnet.sui.io` (read-only RPC, no CLI needed) before this axis can ever close
   autonomously.

2. **Wider-arity Merkle accumulator (re-ranked up from old #4 — now the queue's top measurable
   item).** The 2026-09-05 decomposition found the 20-level Merkle path is 76–81% of
   `transfer.circom`'s and `compliance.circom`'s non-linear constraints — 4–5.7x the identity-
   binding Poseidon calls, and the actual dominant cost neither this queue nor the original
   baseline had isolated before. A `Poseidon(4)`-based depth-10 tree at the same 2^20 leaf capacity
   floors (measured `Poseidon(4)` cost only, ignoring the necessarily larger 4-way selector) at
   ≥39% fewer Merkle-path constraints — UNMEASURED, needs a real `QuaternaryMerkleProof` template,
   a soundness pass on the wider selector, and a negative malformed-path test (this **is** a
   circuit change, unlike the decomposition experiment). Also the natural place to measure
   10^5–10^7-scale batch-insertion cost and indexer throughput, and directly relevant to
   `docs/threat-model.md` RR5 (deposit-commitment linkability / anonymity-set size).

3. **Poseidon2 vs current Poseidon, for real this time.** The 2026-09-05 decomposition confirmed
   Poseidon dominates what it touches, but a real port was blocked on verified BN254 round
   constants (the reference Grain-LFSR generator lives on GitHub, denied this session). Worth
   retrying if a future session's network policy allows GitHub, or finding an already-audited
   external BN254 Poseidon2 constant set to build from instead of generating one by hand. Lower
   ceiling than item 2 above: it can only ever move the ~14–18% "identity/domain Poseidon" share of
   `transfer`/`compliance`'s constraints, per the 2026-09-05 numbers.

4. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

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

13. **Teach `circuits/scripts/compile*.sh` to fall back to `circom2` (npm) when no native `circom`
    binary is on `PATH`.** Not a research experiment — a tooling papercut found 2026-09-05: this
    sandbox has no installable native `circom` (GitHub and `static.crates.io` both policy-denied),
    which blocked the entire circuit toolchain until `circom2` was found and verified as an
    exact-output substitute (see `BASELINE.md`'s toolchain note). A one-line fallback in the three
    `compile*.sh` scripts would save a future night from rediscovering this. Low priority; fold in
    whenever a future night already touches those scripts.
