# Research queue

Ranked list for the nightly loop (`docs/research/NIGHTLY_PROMPT.md`). Highest-ranked item not yet
settled (KEEP/REJECT in `LEDGER.md`) is next. Re-ranked after every run.

## Queue

1. **Batched/aggregated transfer proofs** (N transfers → 1 on-chain Groth16 verification). Prover
   time and constraint count are the biggest numbers Veil pays for today (13,611 constraints/transfer,
   verified individually on-chain); if aggregation amortizes verification cost across a batch, gas
   per transfer drops directly. Promoted to #1 after the baseline run — it's the most direct lever
   on a number Veil already pays for.
2. **Poseidon2 vs Poseidon(current) constraint cost.** transfer.circom alone spends 4 Poseidon
   instances + 4 Num2Bits(64) range checks; if Poseidon2's reduced round count meaningfully cuts
   non-linear constraints, prover time drops without touching the trust model.
3. **Revocation-friendly accumulator vs. the depth-20 Merkle tree.** Today the credential tree can't
   revoke a KYC credential without rebuilding the whole tree; an accumulator (e.g. RSA/bilinear, or
   a sparse Merkle tree with tombstones) trades some proof size/prove time for O(1) revocation. Only
   worth it if the compliance story needs it — check docs/threat-model.md STRIDE entries first.
4. **Threshold auditing (t-of-n) vs. the single auditor ECDH key.** `ComplianceVerifiedEvent`
   ciphertext is bound to one auditor's P-256 key today — a single point of compromise/coercion.
   Threshold decryption (e.g. Shamir over the ECDH shared secret, or a small MPC) removes that
   single point at the cost of auditor coordination overhead.
5. **Merkle accumulator scaling: batch insertion + indexer throughput at 10^5–10^7 commitments.**
   Depth is fixed at 20 (2^20 ≈ 1.05M leaves) — worth knowing empirically where batch-insert cost or
   indexer catch-up time becomes the bottleneck before the anonymity set gets there.
6. **Proof malleability / nullifier collision fuzz.** Feed the `PoseidonMerkleProof`, nullifier, and
   `txAmountHash` gadgets adversarial (malformed, boundary, colliding) inputs under the real Groth16
   pipeline (not the circomlibjs fallback) and confirm every malicious witness the circuit is
   supposed to reject actually gets rejected end-to-end.
7. **Groth16 → PLONK/Halo2 (eliminate the per-circuit trusted setup).** High effort, high payoff:
   Veil's current setup is explicitly a single-contributor dev ceremony (see README "Known
   blockers"). Worth doing once the queue's cheaper wins are exhausted, since it likely means
   rewriting all three circuits' proving/verification pipeline end-to-end, including the Move-side
   verifier.
8. **Post-quantum exposure assessment (design-only).** BN254 pairings and ECDH P-256 are both broken
   by a sufficiently large quantum computer. Not urgent given the testnet-only, unaudited status, but
   worth a design-only (UNMEASURED) pass mapping which primitives are at risk and what a PQ migration
   path would look like, so it's not a surprise later.
9. **Concurrent transfer throughput / shared-object contention on `pool::compliant_transfer`.**
   Requires either localnet or testnet access to measure real contention; blocked today by the same
   sandbox network egress limits as the baseline's gas measurement (see LEDGER.md 2026-07-19 row) —
   re-attempt once `sui` CLI or an allow-listed RPC endpoint is available.
10. **Relayer throughput and what it leaks under load.** `scripts/src/relayer.ts` sponsors gas but
    keeps `sender` as the user (README, "What it actually does"); worth characterizing timing/ordering
    side channels a network observer gets from relayer batching behavior, separate from the `PRIV-002`
    sender-privacy gap already documented in the red-team report.

## Settled (see LEDGER.md for details)

- **BASELINE.md** — KEEP (partial). Circuit constraints, proving time, and proof/VK/wasm/zkey sizes
  measured directly in this sandbox. On-chain gas per entry point and browser/WASM proving latency
  are BLOCKED — no `sui` CLI, no reachable Sui RPC or GitHub host under this sandbox's egress policy.
  See `docs/research/2026-07-19-baseline.md`.
