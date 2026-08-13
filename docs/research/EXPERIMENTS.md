# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked three times now
   (see LEDGER 2026-07-22, 2026-08-13) — the 2026-08-13 attempt narrowed down *why*, precisely:
   `api.github.com` and the releases HTML for non-owned repos both 403 (GitHub access is scoped to
   this repo only), `crates.io`'s web API 403s, and `static.crates.io` (the actual crate-download
   CDN `cargo install` needs) 403s too even though `index.crates.io`'s sparse metadata index is
   reachable — so `cargo install sui` can resolve the dependency graph but not fetch a single
   crate. The direct JSON-RPC fallback to a public Sui fullnode is still proxy-denied. One
   genuinely new lead: plain `git clone https://github.com/iden3/circom` (and presumably
   `github.com/MystenLabs/sui`) **works** even though the GitHub REST API and releases-page HTML
   for the same repo don't — git's smart-HTTP protocol isn't gated the same way. Next attempt
   should try `git clone --depth 1 --branch testnet-vX https://github.com/MystenLabs/sui.git` and
   a *scoped* `cargo build -p sui` (just the CLI binary target, not the full validator workspace)
   before writing off a from-source build again — genuinely untried, not just "judged impractical."
   Budget it as its own night; if the workspace build is still too large, that's a real, specific
   BLOCKED finding this time, not a guess.

2. **Domain-tag hashes at Poseidon2's native arity (t=5, t=6).** 2026-08-13 measured Poseidon2 at
   every arity Veil's domain-tagged hashes need (N=2, 3, 4 real inputs) using `@taceo/circom-lib`'s
   shipped state sizes {2,3,4,8,12,16} — and found the 3-real-input and 4-real-input hashes
   (`oldHash`/`newHash`/`nfHash` in `transfer.circom`, `leafHash` in `compliance.circom`) get
   *worse*, not better, because their natural sizes (t=5, t=6) aren't shipped and padding up to
   t=8 costs more in linear constraints than the non-linear savings recover. Whether
   purpose-generated t=5/t=6 Poseidon2 round constants close that gap is genuinely unmeasured — a
   real cryptographic-parameter-generation task (self-verify against the Poseidon2 paper's
   generation algorithm before trusting the numbers), not a swap. See
   `2026-08-13-poseidon2-merkle-compression.md` Open Questions #2.

3. **Port the Merkle accumulator to Poseidon2 compression mode.** New item, ranked above the older
   backlog because the number is already known and it's now an integration task, not a research
   question: 2026-08-13 measured a real 20-level Merkle proof at −6.35% constraints / −8.85%
   proving time swapping `templates/merkle_proof.circom`'s per-level `Poseidon(2)` for Poseidon2 in
   TACEO's own audited compression-mode construction (`out = perm(t=2)(a,b)[0] + a`). Applies to
   both `transfer.circom` and `compliance.circom` (both use `MerkleProof(20)`). Needs, in the same
   PR: the actual circuit edit, a fresh trusted-setup ceremony (new circuit ⇒ new proving/verifying
   key, RR2 applies again), an updated on-chain VK (`verifier.move`, timelocked per `README.md`), a
   written soundness argument for the compression construction specifically — Veil currently uses
   `Poseidon(2)` as a raw hash, not a Miyaguchi–Preneel-style compressor, so this isn't a drop-in
   substitution even though the constraint numbers are already measured — and the existing
   negative-test suites (`transfer.test.mjs`, `compliance.test.mjs`) extended to the new hasher.
   `withdraw.circom` has no Merkle tree and gets nothing from this.

4. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

5. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). If item 3 lands first, redo
   this experiment's per-level hash cost against the Poseidon2 numbers, not the Poseidon1 ones.

6. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented.

7. **Threshold auditing (t-of-n) vs the single auditor key.** `docs/threat-model.md` asset #6 and
   the ECDH auditor-key design (`docs/auditor-guide.md`) currently assume one auditor keypair.
   A t-of-n threshold scheme (or even measuring the cost of a naive N-of-N re-encryption) changes
   the trust model for compliance data meaningfully and is a natural fit for the "confidential
   payroll with a t-of-n auditor board" use case named in the 2026-07-22 report.

8. **Revocation-friendly accumulators vs the depth-20 credential Merkle tree.** Today, revoking a
   KYC credential means rebuilding the credential root (`compliance.move`, 1-epoch timelock). An
   RSA or Merkle-based revocation accumulator could make single-credential revocation cheaper
   without a full root rebuild — worth a real cost comparison, not just a design note.

9. **Mobile WASM proving latency.** Cheap extension of the 2026-07-22 browser-proving harness
   (`scripts/bench/browser-latency.mjs`) — same script, add a mobile Chromium device-emulation
   profile (`page.emulate(...)`) and compare against the desktop-headless numbers already in
   `BASELINE.md`. Good "spend an hour, get a real number" candidate for a lighter night.

10. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
    `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
    port, not a parameter change — so this should wait until items 1–3 give a clearer picture of
    what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

11. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

12. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

Resolved, no longer queued:

- ~~Fix `circuits`' chained `npm test` hang.~~ Fixed 2026-07-28 outside this loop (PR #17,
  `f942fca`): each test file now calls `process.exit(0)` on its success path so snarkjs' lingering
  bn128 worker handles don't block the `&&` chain. Confirmed tonight (2026-08-13) — `npm test` runs
  all three suites back to back and exits cleanly (108/108 pass). The same fix was needed in this
  session's own new `scripts/bench/poseidon-compare/{prove-latency,negative-test}.mjs` — applied
  there too.
