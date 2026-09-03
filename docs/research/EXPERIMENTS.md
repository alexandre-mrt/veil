# Experiment queue

Ranked highest-value first. "Value" = moves a number Veil actually pays for (prover time, gas,
anonymity-set size) or closes a threat currently unmitigated (see `docs/threat-model.md`). Take the
top item not already settled KEEP/REJECT in `LEDGER.md`. Re-rank whenever a night's result changes
what matters most — say why in the commit, don't just reorder silently.

1. **On-chain gas per entry point.** `BASELINE.md`'s one missing axis. Blocked a third time on
   2026-09-03, now for a precisely characterized, non-retryable reason (see LEDGER): GitHub access
   is scoped to this repo only (`github.com/MystenLabs/sui` — releases, API, any tag — returns 403
   regardless of endpoint), and direct network egress to any other host is denied by the sandbox's
   own org policy (`fullnode.testnet.sui.io:443` JSON-RPC, no GitHub involved, still
   `connect_rejected`), and `crates.io`'s API also 403s despite being nominally proxy-allowlisted.
   No further in-session workaround is worth attempting — the next run should not repeat the
   GitHub-release or ad-hoc-RPC attempts. What would actually unblock this: a network-policy
   exception for a named Sui RPC/release host, or a `sui` binary supplied by the environment itself
   (setup script, container image) rather than fetched at runtime. Escalate to whoever configures
   this session's environment before spending another night on it.

2. **A real Poseidon2 port — scoped to the Merkle-path `Poseidon(2)` calls specifically, not a
   uniform swap.** 2026-09-03's constraint-attribution experiment
   (`2026-09-03-transfer-constraint-attribution.md`) found that 75.1% of `transfer.circom`'s
   non-linear constraints (4,860 of 6,470) come from the 20 `Poseidon(2)` calls inside the
   depth-20 `MerkleProof(20)` template — not the four `Poseidon(3)`/`Poseidon(4)` instances the
   circuit's own comments call out (only 18.0% combined), and `compliance.circom` almost certainly
   shares the same shape (same `MerkleProof(20)` template — worth confirming with the same script
   before committing to the port). A Poseidon2 swap should target the arity-2 hash used in Merkle
   paths first: smaller diff, most of the available savings. **Blocked on a real reference to
   verify round constants/MDS matrix against** — no vetted BN254 Poseidon2 circom template exists
   on npm, and this session's GitHub access does not reach `iden3/circomlib` or any other upstream
   source to check one. Do not hand-derive Poseidon2 round constants without a way to cross-check
   them; that's a soundness bug waiting to happen, not a shortcut worth taking under time pressure.

3. **Confirm `compliance.circom` shares `transfer.circom`'s ~75%-from-Merkle attribution.** Cheap,
   same-night extension of `scripts/bench/constraint-attribution.mjs` — swap the instance-count
   table for `compliance.circom`'s gadgets (`Poseidon(5)` credential leaf, `Poseidon(3)`×2
   nullifier/context hash, same `MerkleProof(20)`) and rerun. Directly gates whether item 2's
   Merkle-path-first Poseidon2 scoping applies to both circuits or just `transfer.circom`. Good
   "spend an hour, get a real number" candidate — no new toolchain needed, the blocker that stops
   item 2 (no Poseidon2 reference to verify against) doesn't apply here since this is attribution,
   not a port.

4. **Merkle accumulator at scale (10^5–10^7 commitments).** Batch insertion cost, depth-20 vs a
   deeper tree, and indexer throughput for reconstructing the tree client-side. 2026-09-03 gives
   this a precise per-level price for the first time: each additional depth level costs exactly
   243 non-linear constraints in `transfer.circom` (measured `Poseidon(2)` per-instance cost) — so
   depth 20 → 24 (2^20 ≈ 1M anonymity set → 2^24 ≈ 16M) costs `4 × 243 = 972` more non-linear
   constraints, about 15% of the current circuit, for 16x the anonymity set. The constraint-cost
   side of this trade-off no longer needs its own measurement; what's still open is proving-time
   impact at a few real depths and indexer throughput. Directly relevant to `docs/threat-model.md`
   RR5 (deposit-commitment linkability).

5. **Batched/aggregated proof verification (N transfers → 1 on-chain verify).** Reduces the
   per-transfer gas cost of `sui::groth16` verification, which today is paid once per transfer.
   Depends on item 1 existing first (need a real per-verify gas number to know how much this would
   actually save).

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
    port, not a parameter change — so this should wait until items 1–2 give a clearer picture of
    what's actually worth optimizing before committing a multi-night effort to a proof-system swap.

11. **Post-quantum exposure.** BN254 discrete log breaks under a sufficiently large quantum
    computer; Groth16 on BN254 has no PQ story. Likely a design-only, UNMEASURED-labelled
    experiment (no PQ-SNARK toolchain is likely to install cleanly here either) assessing what a
    migration path would cost, not a benchmark.

12. **Relayer throughput and leakage under load.** `scripts/src/relayer.ts` — real load-testing
    (requests/sec before rate-limiting kicks in, timing side-channels that could deanonymize
    sender-relayer pairs under concurrent load) is unmeasured.

13. **Fix `circuits`' chained `npm test` hang.** Not a research experiment — a small tooling
    papercut noticed during the 2026-07-22 baseline run: real (non-hash-only) `snarkjs.groth16`
    calls leave the Node process alive after the test file finishes printing results, which stalls
    the `&&`-chained `npm test` script after the first file. Each file passes fine run
    individually. Low priority; fold into whichever future night touches `circuits/test/`.

14. **`compliance-utils` test suite is slow (~3.5 min for 67 tests).** Noticed 2026-09-03,
    unrelated to that night's change: `buildMerkleTree` builds a complete, real-Poseidon-hashed
    tree padded to `2^depth` leaves, and the compliance-utils test suite calls it at depth 20
    (~2^20 leaf slots) at least once. Not urgent — it passes, just slowly — but worth checking
    whether the test actually needs a full depth-20 tree or could use a shallower one and pass the
    depth as a parameter to the functions under test.
