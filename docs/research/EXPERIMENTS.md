# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

**2026-08-05 re-rank:** item 2 (Poseidon2 vs Poseidon) is now settled **REJECT** — see LEDGER and
[`2026-08-05-poseidon2-arity-mismatch.md`](2026-08-05-poseidon2-arity-mismatch.md). Left in place at
position 2, struck through, rather than renumbering everything below it — it's cross-referenced by
number from the ledger and the report. Skip it; nothing below it changed priority as a result of
tonight's run. A new item is appended at the end (13) for the one open question that result raised:
whether a Poseidon2 implementation with *native* t=5/t=6 support (instead of padding to t=8) would
change the verdict — deliberately not attempted tonight, since generating fresh,
independently-unverified round constants is a cryptographic construction task, not a benchmark. Item
1 was re-attempted (not re-ranked, still #1) as an early-session unblock check: still BLOCKED, now
with a more precise diagnosis — note updated below.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Needs a working `sui` CLI
   (prebuilt binary, or a from-source build budgeted across more than one night) or explicit
   permission to make direct JSON-RPC reads against the already-deployed testnet package
   (`README.md` has real package/pool/config IDs — `suix_queryTransactionBlocks` against a public
   fullnode could recover real historical gas without the CLI at all, if that network call is
   permitted). Blocked three times now: 2026-07-22 by a tool-approval denial on both the `sui`
   source build and a fallback RPC call; 2026-08-05 by a hard network-policy `403` on every Sui RPC
   host tried (testnet, mainnet, and a third-party public node) plus `github.com` release downloads
   — a firmer, more conclusive block than either previous attempt, but a block all the same. Only
   remaining open path is a from-source `sui` CLI build (Rust workspace, RocksDB, validator, Move
   VM) budgeted explicitly across multiple nights, or a change to the network policy.

2. ~~**Poseidon2 vs current Poseidon (arity, domain-tag collisions).**~~ **SETTLED — REJECT,
   2026-08-05.** See LEDGER and
   [`2026-08-05-poseidon2-arity-mismatch.md`](2026-08-05-poseidon2-arity-mismatch.md). The one
   audited BN254 Poseidon2 circom implementation available (`@taceo/circom-lib`) doesn't natively
   support the state width Veil's dominant hash call needs (t=5, from `Poseidon(4)`); padding to
   the nearest supported width (t=8) costs +93.0% R1CS constraints and +16.6% Node proving time,
   measured on a full `withdraw_poseidon2.circom` variant. Do not re-run against the same library
   without new information — see item 9 for the one open variant (native t=5/t=6 constants) that
   might change this.

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
    individually. Low priority; fold into whichever future night touches `circuits/test/`.

13. **Poseidon2 with natively-generated t=5/t=6 round constants.** 2026-08-05 rejected Poseidon2
    for Veil because the only audited BN254 circom implementation available (`@taceo/circom-lib`)
    doesn't support the state widths Veil's `Poseidon(4)`/`Poseidon(5)` calls need (t=5/t=6) and
    padding to t=8 costs more than it saves. A from-scratch Poseidon2 instantiation at the exact
    widths Veil needs might avoid that penalty entirely — but generating and trusting fresh round
    constants for a permutation width with no published reference vectors is a real cryptographic
    construction task (needs the reference constant-generation algorithm re-derived and
    cross-checked against at least one independent implementation before it's safe to use in a
    circuit), not a parameter tweak. Ranked low deliberately: real risk of shipping an unverified
    primitive if rushed, and the potential upside (recovering the ~21% microbenchmark-scale win at
    full-circuit scale) is unconfirmed, not proven — Table 2 vs Table 3 in the 2026-08-05 report
    shows the same relative constraint/witness-gen tradeoff could still lose even at native width.
