# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

**Re-ranked 2026-08-25** (see `LEDGER.md` and
[`2026-08-25-poseidon-constraint-attribution.md`](2026-08-25-poseidon-constraint-attribution.md)):
the constraint-attribution night found the 20-level Merkle path alone accounts for 76–81% of
non-linear constraints in `transfer.circom`/`compliance.circom` — bigger than every direct-hash
Poseidon call combined, and actionable without any new unverified cryptography. That moves it above
the Poseidon2 swap, which is now blocked on a verified circom implementation neither the npm
registry nor this sandbox's egress policy currently makes reachable. On-chain gas (previously #1) is
demoted: it's now a **confirmed organization network-policy block** (403 on `github.com` and
`fullnode.testnet.sui.io`, verified by direct `curl`, not just a denied tool call), not a toolchain
gap — repeating the same attempt wastes a night's budget until the policy itself changes.

1. **Merkle accumulator depth vs. anonymity-set size (was #4).** The single highest-leverage
   remaining lever for prover time in `transfer.circom`/`compliance.circom`: the depth-20 Merkle
   path is 76–81% of non-linear constraints (2026-08-25 attribution), more than all direct Poseidon
   hashes combined, and shrinking it doesn't need a new, unverified hash primitive the way Poseidon2
   does. But depth is also the anonymity-set lever (`docs/threat-model.md` RR5) — this needs a real
   cost comparison (batch insertion cost, indexer throughput, proving-time delta per depth) *and* an
   honest privacy tradeoff analysis, not just a constraint-count number. Directly builds on
   `scripts/bench/gadget-attribution.mjs`'s `merkle_level` gadget (cost per level is already
   measured: 246 non-linear / 274 linear / 520 total) — a depth sweep is now cheap to run.

2. **Poseidon2 vs current Poseidon (arity, domain-tag collisions).** 2026-08-25 measured the exact
   ceiling — Poseidon (all instances, including the Merkle path) is 78–95% of non-linear constraints
   across all three circuits — but did not attempt the swap itself: no circom Poseidon2 circuit
   template is reachable from the npm registry (only plain hash-function implementations,
   `poseidon2`/`@zkpassport/poseidon2`/`@taceo/poseidon2`), and the reference needed to hand-write
   one safely (official round constants, round structure) lives on GitHub/IACR ePrint, both blocked
   by the same confirmed network policy as item 6 below. Blocked until either the policy opens one
   of those hosts, or someone supplies a verified circom Poseidon2 implementation directly (e.g. via
   a reachable package registry, or pasted into the repo with its provenance documented).

3. **Adopt `circom2` as the documented toolchain (new, cheap).** 2026-08-25 found and validated
   `circom2` — a WASM build of the circom 2.x compiler on the npm registry
   (`npm install --no-save circom2` in `circuits/`) — reproduces the existing baseline byte-for-byte
   and needs no GitHub access, unlike the current `README.md`/`compile.sh` instructions (`cargo
   install` + `git clone iden3/circom`). Low effort, directly removes a now-twice-confirmed blocker
   for every future night that needs to compile circuits in a similarly restricted sandbox. Good
   "spend an hour" candidate for a lighter night.

4. **Independent circuit soundness audit.** Under-constrained signals, alias checks (BN254 field
   wraparound beyond what T30 in `transfer.test.mjs` already covers), nullifier collision analysis
   across the three circuits' eight domain tags, proof malleability. Adversarial, not a redesign —
   the existing test suites are thorough but self-referential; worth a pass that tries to break the
   circuits rather than confirm they work as documented. No dependency on any blocked toolchain.

5. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Still depends on item 6 (on-chain gas) for a real baseline to size the savings against.

6. **On-chain gas per entry point.** Demoted from #1 — this is now a **confirmed organization
   network-policy block**, not a toolchain gap: `github.com` (for a prebuilt `sui` CLI) and
   `fullnode.testnet.sui.io` (for a direct JSON-RPC read) both return `403` at the CONNECT stage,
   verified directly with `curl` on 2026-08-25 (not just a denied tool call, as on 2026-07-22).
   Building `sui` from source remains impractical within a night's budget (full validator + Move VM
   + RocksDB workspace). **Do not re-attempt this from inside the sandbox without a policy change**
   — if this loop needs the number, it needs either an allowlist change from whoever administers the
   egress policy, or to run on a machine with different network access. Worth flagging outside this
   loop rather than re-spending a night confirming the same block a third time.

7. **Merkle accumulator at scale (10^5–10^7 commitments) — indexer/throughput half.** Batch
   insertion cost and indexer throughput for reconstructing the tree client-side, as distinct from
   item 1's depth-vs-anonymity-set-vs-constraints analysis. Split out so item 1 can proceed without
   waiting on this.

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
    port, not a parameter change — so this should wait until items 1–2 give a clearer picture of
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
    individually (reconfirmed 2026-08-25). Low priority; fold into whichever future night touches
    `circuits/test/`.
