# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked a third time
   2026-08-04, now with a sharper diagnosis than either prior attempt: `fullnode.testnet.sui.io`
   and `static.crates.io` (crate downloads — the registry *index* is reachable, actual crates are
   not) both return a hard `403` at this sandbox's network proxy, a standing policy denial rather
   than a retriable tool-approval prompt. This looks structural to the sandbox, not something a
   from-source build or a different RPC call routes around. Worth flagging to whoever configures
   this environment's network policy before spending a fourth night on pure workarounds; if the
   policy can't change, this may need to be attempted from a differently-configured environment.

2. **Poseidon2 at t=5 (Veil's dominant Poseidon width).** Settled at t=3 2026-08-04 — REJECT (see
   LEDGER, `2026-08-04-poseidon2-vs-poseidon.md`): ties `circomlib`'s Poseidon under `--O2`, loses
   under `--O1`. But t=3 isn't where Veil's cost actually lives — `transfer.circom` and
   `compliance.circom`'s Poseidon(4)/t=5 calls (5 of 8 total Poseidon instances across all three
   circuits) dominate, and Poseidon2 has **no official BN254 parameter set at t=5 at all** (the
   reference implementation only publishes `{2,3}` and multiples of 4). This item is now: either
   (a) run the Poseidon2 authors' own parameter-generation script for t=5 and independently verify
   the output against a second implementation before trusting it in a circuit, or (b) evaluate
   restructuring the four Poseidon(4) calls to a supported width (t=8 most likely — check whether
   the wasted capacity slots still net a constraint win before committing to it). Real engineering,
   not a rounding error on a t=3 result — re-ranked down accordingly.

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

13. **Why do Poseidon and Poseidon2 (t=3) converge to exactly the same non-linear constraint count
    under `--O2`, despite different partial-round counts (57 vs 56)?** Curiosity noticed but not
    chased down 2026-08-04 (`2026-08-04-poseidon2-vs-poseidon.md`, Open questions). Low priority —
    doesn't change any KEEP/REJECT verdict — but worth understanding which specific `--O2`
    substitution does it, since it bears on how much "fewer partial rounds" claims for Poseidon-
    family hashes actually translate to R1CS/Groth16 circuits generally, not just this one case.
