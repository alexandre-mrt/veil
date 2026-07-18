# Experiment Queue

Ranked highest to lowest priority. An item is settled once `LEDGER.md` has a KEEP/REJECT row for
it; PARK/BLOCKED rows stay in the queue (re-ranked, with the unblock condition stated) until
they get a terminal verdict. Never silently re-run a settled experiment — if one deserves a
rematch, say why in the ledger note and re-rank it here.

1. **Unblock on-chain gas measurement.** Tonight's baseline (`2026-07-18-baseline-measurement.md`)
   could not measure gas per entry point: no `sui` CLI reachable from this session (GitHub access
   scoped to `alexandre-mrt/veil` only; no crates.io/npm distribution of the real binary; no
   already-deployed instance to dry-run against). Two independent unblocks, either sufficient:
   (a) an execution environment with `sui` CLI pre-installed or GitHub access to
   `MystenLabs/sui` releases, run once to `sui client publish` a testnet instance and commit its
   package ID (non-secret) to the repo; or (b) after (a) happens once, all future gas numbers
   need only `@mysten/sui`'s `dryRunTransactionBlock` against public RPC — no compiler needed
   again. Note the risk: if the nightly loop always runs in this same sandboxed environment,
   this item will re-block every time it's picked up until the environment itself changes —
   worth flagging to whoever configures the routine, not just re-attempting blindly.

2. **Batched/aggregated proofs — N transfers, 1 on-chain verification.** The highest-leverage
   scalability lever named in the loop's own brief: gas is currently paid once per transfer.
   Recursion (folding an N-proof batch into one Groth16/PLONK verification) or naive proof
   aggregation both reduce verifier calls; the interesting number is the crossover batch size
   where amortized prover time + one verification beats N separate proofs + N verifications.
   Measurable now without the gas unblock: constraint count and prove time for a small
   recursive/aggregate circuit vs. N × tonight's `transfer` baseline (966ms, 13,611 constraints).
   Gas comparison slots in once #1 unblocks.

3. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion throughput, indexer
   throughput, and the depth-vs-anonymity-set trade-off (deeper tree = bigger anonymity set =
   more Merkle-path constraints = slower proving — tonight's `transfer` baseline already pays
   ~1/3 of its 13,611 constraints on a depth-20 path with an all-zero witness; real-world path
   costs are already priced in, just not yet varied by depth). Fully measurable now — no `sui`
   needed, pure JS/circom benchmarking.

4. **Poseidon2 vs Poseidon, arity, and domain-tag collision review.** Poseidon is 4/8/12 of
   tonight's per-circuit constraint budget (commitments, nullifiers, Merkle nodes, context
   binding all reduce to it). Poseidon2 claims meaningfully fewer constraints per hash at the
   same security level. Also: a systematic pass over the 8 domain tags currently in use
   (1 commitment, 2 transfer nullifier, 3 amount hash, 4 credential leaf, 5 credential
   nullifier, 6 context binding, 7 withdraw nullifier, 8 recipient) for any two that could
   collide under adversarial input choice. Fully measurable now.

5. **Circuit soundness audit.** Systematic pass for under-constrained signals, alias checks on
   the four Num2Bits(64) range-proof families, nullifier-collision resistance across all three
   circuits' nullifier derivations, and Groth16 proof malleability on the current verifier
   config. Requires a negative-test-per-finding deliverable per the loop's own rule for circuit
   work. No toolchain blocker.

6. **Dual-proof compliance cost vs. a revocation-friendly accumulator.** `compliant_transfer`
   currently verifies two full Groth16 proofs atomically (transfer + compliance, 13,611 +
   12,743 = 26,354 constraints combined per tonight's baseline). Compare against a design that
   replaces the credential Merkle tree with a revocation-friendly accumulator (e.g.
   RSA/bilinear accumulator) trading proof complexity for O(1) revocation instead of the current
   admin-timelocked root rotation. Constraint-side measurable now; gas-side blocked on #1.

7. **Threshold (t-of-n) auditing vs. the single auditor key.** `docs/threat-model.md` asset #4
   and residual risk RR2-adjacent: today one auditor ECDH key decrypts every compliance
   ciphertext. Model the cost of a t-of-n threshold-decryption scheme (or per-transfer key
   rotation) against the single-key design. Likely a first-pass design/UNMEASURED experiment —
   no existing threshold crypto in the stack to benchmark against yet.

8. **Mobile WASM proving latency.** Tonight's browser number (1.4–2.6s for `transfer`) is
   desktop headless Chromium on a 4-vCPU cloud box, not a phone. Extend
   `scripts/bench/browser-prove-bench.mjs` with Chromium's mobile CPU-throttling emulation
   (`Page.emulateCPUThrottling` via CDP) as a floor estimate, and flag it clearly as emulated,
   not a real device, until one is available.

9. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` sponsors gas but
   (per `README.md`, PRIV-002) does not hide the sender. Under concurrent load, does
   timing/ordering leak anything beyond that already-documented gap? Needs a local load-test
   harness against the relayer; does not need a live `sui` network for the leakage-analysis
   half, but does for the throughput half — partially blocked on #1.

10. **PLONK/Halo2/Nova-folding migration feasibility.** Eliminating the trusted setup (RR2 in
    the threat model) and/or enabling cheap recursion for #2. Large decision, first pass should
    be a design-only literature + tooling-maturity comparison (circom→PLONK backends,
    Sui's native verifier support or lack thereof for non-Groth16 proof systems) labelled
    UNMEASURED, not a rewrite attempt.

11. **Post-quantum exposure assessment.** BN254 discrete-log hardness is not post-quantum safe;
    scope what breaks (proof soundness fully, or just the trusted-setup toxic waste secrecy?)
    and what a PQ-safe swap would cost in constraint count. Design-only first pass.
