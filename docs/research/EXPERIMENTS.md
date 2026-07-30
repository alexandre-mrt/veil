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
   permitted). **Blocked three nights running now, for three different reasons**: 2026-07-22
   tool-approval denial mid-session; 2026-07-30 a hard, non-retryable org-policy `403` from the
   sandbox's egress proxy on both `fullnode.testnet.sui.io` and `api.github.com` (confirmed via
   `/root/.ccr/README.md` — "do not retry or route around it"; `registry.npmjs.org` and
   `raw.githubusercontent.com`/`release-assets.githubusercontent.com` were reachable the same
   night, so it's a specific-host policy, not a blanket block). Still worth an early-run attempt
   next time, but stop trying JSON-RPC to `fullnode.testnet.sui.io` specifically if the same `403`
   recurs — that host looks policy-blocked, not transiently unavailable.

2. **Hand-optimized Poseidon2 t=3 linear layer for the Merkle-path hash.** Direct follow-up to
   2026-07-30 (`poseidon2-merkle-hash`, REJECT). That experiment verified the Poseidon2 t=3 round
   constants and permutation correctness (byte-for-byte against the HorizenLabs reference, 8
   end-to-end test vectors against an independent implementation) but found the *vendored*
   `@taceo/circom-lib` template's linear layer (`ExternalMatMul3`/`InternalMatMul3`) costs +1,260
   R1CS constraints per proof because it uses named-signal intermediates instead of circomlib's
   `var`-accumulator folding (`Mix`/`MixS` in `node_modules/circomlib/circuits/poseidon.circom`).
   Rewriting just the linear layer with the same folding trick, reusing the already-verified round
   constants, is a well-scoped, low-soundness-risk night: if it still doesn't beat circomlib's
   original Poseidon even with an optimal linear layer, that's a much stronger final answer on
   whether Poseidon2 helps Veil's Merkle hash at all.

3. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

4. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree (anonymity-set size vs proving-time trade-off directly, since Merkle depth is a
   circuit parameter), and indexer throughput for reconstructing the tree client-side. Directly
   relevant to `docs/threat-model.md` RR5 (deposit-commitment linkability — a bigger anonymity set
   is the main lever available without redesigning the deposit flow). Also now the natural place to
   check whether item 2's Merkle-hash finding holds at depths other than 20 — see 2026-07-30's open
   questions.

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

12. **Search for a published, audited Poseidon2 t=5 parameter set.** New from 2026-07-30: the
    commitment/nullifier hashes (`Poseidon(4)`, t=5) are the ones originally named in this queue's
    Poseidon2 framing, but no published parameter set for t=5 was found on npm or in the
    HorizenLabs reference during that night's search (only t ∈ {2,3,4,8,12,16} are published).
    Worth a dedicated, short, search-only night before concluding a t=5 swap would require
    hand-deriving constants (a meaningfully bigger soundness commitment than reusing a published
    set).

~~13. Fix `circuits`' chained `npm test` hang.~~ **Resolved before this queue was written up
    tonight** — `npm test` was re-run chained (`transfer.test.mjs && compliance.test.mjs &&
    withdraw.test.mjs`) on 2026-07-30 and completed cleanly (exit 0, no hang), fixed by an earlier
    commit (`#17`, "exit test runners explicitly after the last proof") not part of this loop.
    Removed from the active queue. Note: the *same* underlying issue (snarkjs keeps worker handles
    open) was independently found and fixed tonight in `scripts/bench/prove-latency.mjs` and
    `prove-latency-v2.mjs`, which hadn't gotten the #17 fix — worth a quick grep across
    `scripts/src/*.ts` for the same pattern on a future lighter night.
