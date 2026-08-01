# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked three times now
   (2026-07-22, 2026-08-01) for increasingly well-diagnosed reasons: no prebuilt `sui` binary
   reachable, a from-source build of the full Sui workspace judged impractical within one night's
   budget, `cargo install sui` resolves to an unrelated nameless placeholder crate (not the real
   CLI), and as of 2026-08-01 direct JSON-RPC to the public testnet fullnode is a confirmed,
   explicit network-policy 403 on the CONNECT tunnel itself (not retried, per policy on org-policy
   denials). One thing newly works as of 2026-08-01: plain `git clone` to arbitrary GitHub repos
   succeeds even though `api.github.com`/`codeload.github.com` don't — this reopens a from-source
   `sui` build (or a minimal subset sufficient for gas introspection) as a real option. Worth a
   night specifically budgeted for attempting that build, rather than another quick look that
   re-discovers the same dead ends.

2. **Poseidon2 for the Merkle-path hasher (not the four named domain-tag hashes).** The
   2026-08-01 constraint-decomposition experiment closed the "which Poseidon calls dominate" question
   with an exact number: 76–81% of `transfer.circom`'s and `compliance.circom`'s non-linear
   constraints are the 20 `Poseidon(2)` calls inside `MerkleProof(20)`, not the four named
   domain-tag hashes the source comments enumerate (those are a minority — see
   `BASELINE.md`'s constraint-breakdown table). A Poseidon2 swap should be scoped to that hasher
   specifically. Still blocked on the same thing that stopped 2026-08-01 from attempting it: no
   vetted Poseidon2 circom implementation reachable in this environment to port from (GitHub access
   is scoped to this repo only, and `circomlib` doesn't ship one) — hand-deriving Poseidon2's round
   constants and partial-round MDS matrix without a reference to verify against is exactly the kind
   of unverified cryptographic surface this loop should not risk on a production, Groth16-verified
   circuit in one night.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

4. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). The 2026-08-01 decomposition
   already gives the exact per-level circuit cost (243 non-linear / 274 linear constraints per
   `Poseidon(2)` level) — use that directly instead of re-deriving it when this experiment runs.

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

13. **Does circom's alias-vs-linear-combination constraint-elimination rule generalize?** The
    2026-08-01 decomposition found that a pure signal-to-signal `===`/`<==` costs 0 extra R1CS rows
    under circom's default simplification, while one involving a `+`/`-`/`*` operator costs exactly
    1 — verified against three circuits, all consistent. Worth a quick check against a fourth,
    structurally different circuit before treating it as a general fact rather than a coincidence of
    these three. Low priority, cheap to check whenever a future night touches a new circuit.
