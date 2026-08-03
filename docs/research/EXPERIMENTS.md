# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

**Re-ranked 2026-08-03.** The Poseidon2 experiment ([`2026-08-03-poseidon-constraint-attribution.md`](2026-08-03-poseidon-constraint-attribution.md))
rejected the hash-swap hypothesis but produced a real, exact per-level cost for the Merkle
authentication path (245 non-linear constraints/level, 76–81% of `transfer.circom`'s and
`compliance.circom`'s total). That's the missing prerequisite item #4 (Merkle accumulator at
scale) needed — promoted to top of queue. On-chain gas (former #1) was re-attempted with two new
approaches this run (see LEDGER 2026-08-03) and is demoted from an automatic top slot to #2: it's
still high value, but two consecutive nights have now spent real time on it without a number to
show, and it's genuinely tooling-blocked rather than one lucky unblock away — the next attempt
should carry a multi-hour budget specifically, not compete with a one-night experiment slot.

1. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree — now with a **real, measured per-level cost**: each additional depth level costs
   exactly 245 non-linear constraints (one `Poseidon(2)` + one `MultiMux1(2)` + one boolean check,
   see `scripts/bench/poseidon-constraint-attribution.sh`), against 2× the anonymity-set size per
   level. That's a genuine trade-off curve this experiment can now plot with real proving-time
   deltas (compile depth-21/22/24/etc. `MerkleProof` variants, re-run `prove-latency.mjs`), not
   just a design note. Also covers indexer throughput for reconstructing the tree client-side.
   Directly relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability).

2. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked three times now
   (2026-07-22 ×2 reasons, 2026-08-03 ×2 new reasons — see `LEDGER.md`). What's confirmed as of
   2026-08-03: direct JSON-RPC to any Sui fullnode/public-RPC host is a **categorical, confirmed**
   proxy-policy 403 (tested against 3 different hosts) — stop trying that route. Building `sui`
   from source is real but slow: `git clone https://github.com/MystenLabs/sui.git` **works** in
   this sandbox (arbitrary GitHub repos, not just origin, via the session's git URL rewrite), and
   `cargo build` needs `net.git-fetch-with-cli = true` in `.cargo/config.toml` to get past its
   first pinned git dependency — with that fix, a build reached 4.8GB/1600+ crates compiled in 17
   minutes before running out of session budget. Next attempt: resume that exact build (preserve
   the `git-fetch-with-cli` fix) with a **multi-hour**, not one-night-shared, budget, specifically
   to unlock `sui move test` (124 tests, still never run) and a **local-network** (`sui start`)
   gas measurement against the real compiled bytecode — the deployed-testnet JSON-RPC route is
   dead, but a local measurement against identical bytecode is still a real, legitimate number.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, today paid once per transfer. Depends on
   item 2 existing first (need a real per-verify gas number to know how much this would actually
   save).

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

8. **Trusted-setup elimination (PLONK / Halo2 / Nova-folding).** Directly addresses
   `docs/threat-model.md` RR2 (dev-only single-contributor ceremony). Large lift — a full circuit
   port, not a parameter change. Note from 2026-08-03: this is also the venue where Poseidon2
   would actually pay off (AIR/STARK-style arithmetizations charge for the hash's linear-layer
   width, unlike R1CS) — if this migration is ever picked up, re-evaluate Poseidon2 as part of it
   rather than treating that as settled by tonight's REJECT (which is scoped to Groth16/R1CS only).

9. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
   computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
   experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
   migration path would cost, not a benchmark.

10. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

11. **Reduced-round Poseidon/Poseidon2 with an independently re-derived security margin.** New
    2026-08-03: the *only* lever identified tonight that could actually cut non-linear constraint
    count for Veil's hash-heavy circuits (unlike a same-round-count "v2" swap, which this run
    showed has no R1CS effect). Speculative and risky — needs either a verified round-constant/
    cryptanalysis source (currently unreachable: `eprint.iacr.org` and `arxiv.org` are both
    blocked in this sandbox, confirmed) or an independent cryptographic audit before it's safe to
    even prototype. Low priority until one of those is available.

12. **Fix `circuits`' chained `npm test` hang.** Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run: real (non-hash-only) `snarkjs.groth16`
    calls leave the Node process alive after the test file finishes printing results, which stalls
    the `&&`-chained `npm test` script after the first file. Each file passes fine run
    individually (confirmed again 2026-08-03). Low priority; fold into whichever future night
    touches `circuits/test/`.
