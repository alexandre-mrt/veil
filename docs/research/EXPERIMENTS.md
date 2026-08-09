# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked a second time on
   2026-08-09 (see LEDGER) — now precisely characterized, not just "no CLI": (a)
   `fullnode.testnet.sui.io` is denied at the network-policy layer (403 via the sandbox's proxy,
   confirmed in `recentRelayFailures`, not a retriable per-call tool-approval prompt this time);
   (b) `MystenLabs/sui` prebuilt release binaries are unreachable because this session's GitHub
   integration is scoped to `alexandre-mrt/veil` only (`api.github.com` explicitly refuses any other
   repo); (c) no real `sui` CLI crate exists on crates.io (`sui_cli` is a 0.0.1 name reservation with
   no content). All three are session/environment configuration, not something a different attempt
   within the same session fixes. Next run should not re-attempt these paths — either request the
   network policy allow `fullnode.testnet.sui.io`, or request `MystenLabs/sui` added to this
   session's GitHub scope, before spending more budget here.

2. **Poseidon2 vs current Poseidon — linear-layer constraint/proving-time delta.** **SETTLED
   REJECT, 2026-08-09** (see LEDGER and
   [`2026-08-09-poseidon2-linear-layer.md`](2026-08-09-poseidon2-linear-layer.md)): measured, with
   real R1CS constraint counts and two independent proving-time trials, that Poseidon2's efficient
   linear layer produces **zero** constraint-count change and no reproducible proving-time change
   for Veil's Groth16/circom setup, because circom's default `--O1` simplification already makes
   Poseidon's dense MDS multiply free in R1CS terms. Do not re-run this in the current
   arithmetization without new information (e.g. a different circom optimization level, ruled
   unlikely to matter but untested — see that report's open question #4). Do not silently re-attempt
   a full Poseidon2 *migration* on the original "reduce prover time" premise — that premise didn't
   survive measurement.

2b. **Poseidon2 for native (non-circuit) hashing throughput.** New, narrower item spun out of 2's
   result: the linear-layer efficiency this experiment ruled out *for proving* would still show up
   as a real number for anything hashing outside a SNARK — specifically the indexer/relayer
   Merkle-tree-building path (`scripts/src/compliance-utils.ts`'s `buildMerkleTree`) and browser
   witness precomputation. Still needs the same official-BN254-parameters blocker resolved first
   (see below) unless scoped to a field/toolchain where reference constants are already available
   (the `poseidon2` npm package ships validated Goldilocks-12 and Vesta-3 instances directly).

2c. **Blocker: validated Poseidon2 BN254 parameters.** No official round constants/matrices for
   BN254 were reachable this session — `HorizenLabs/poseidon2`'s precomputed-constants directory and
   parameter-generation sage script are both on GitHub outside this session's repo scope, and no
   `sage` toolchain is installed locally. Needed before *any* Poseidon2 variant (full migration or
   the native-hashing item above) can be built with real security claims instead of self-generated,
   unverifiable constants. Candidates: request GitHub scope extension for `HorizenLabs/poseidon2`,
   or install `sage`/reimplement the Grain-LFSR generation script locally and cross-check against a
   published test vector from a field where one is available.

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

~~12. Fix `circuits`' chained `npm test` hang.~~ **Done, outside this loop** — fixed in #16/#17
    (2026-07-28, `fix(circuits): exit test runners explicitly after the last proof`). Confirmed
    resolved during this run's regression check: `transfer`/`compliance`/`withdraw` test files all
    exit cleanly now.
