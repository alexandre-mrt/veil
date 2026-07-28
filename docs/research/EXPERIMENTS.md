# Veil research queue

Ranked list of candidate experiments for the nightly loop (`docs/research/NIGHTLY_PROMPT.md`).
Each night takes the highest-ranked item not already settled KEEP/REJECT in `LEDGER.md`. Re-ranking
happens after every run — see the ledger for why an item moved.

Rank is a rough read of "moves a number Veil actually pays for" (prover time, gas, anonymity-set
size, or an unmitigated threat), not effort.

## Queue

1. **On-chain gas per entry point** (`deposit_and_register`, `shielded_transfer`,
   `compliant_transfer`, `zk_withdraw`). Blocked on 2026-07-28 — needs an environment with a working
   `sui` CLI or unblocked JSON-RPC egress. This is the missing half of `BASELINE.md`; nothing about
   proof-aggregation or batching savings can be quantified until this exists. *Requeued from
   2026-07-28's BASELINE run — see that report for exactly what was tried.*
2. **Batched/aggregated proof verification** — N `shielded_transfer`s verified in one on-chain
   Groth16 check instead of N. Constraint-count and gas math both live in `BASELINE.md` once #1
   lands; this is the first thing worth comparing against it.
3. **PLONK/Halo2 comparison against the Groth16 baseline** — same three circuits, universal/updatable
   setup, compare constraint count, proving time, proof size against `BASELINE.md`. Answers whether
   the single-contributor dev trusted setup (`circuits/scripts/compile.sh`) is worth eliminating
   before the multi-party ceremony (`ceremony.sh`) is ever run for real.
4. **Merkle accumulator at scale (10^5–10^7 commitments)** — batch insertion cost, indexer throughput,
   and the depth-20 anonymity-set-size trade-off. Currently the tree is only ever exercised with 1
   leaf in tests.
5. **Revocation-friendly credential accumulator vs. the depth-20 credential Merkle tree** —
   compliance.circom's KYC membership proof today has no revocation path short of rotating the whole
   root. Worth pricing against an RSA/bilinear accumulator.
6. **Poseidon2 migration** — arity and domain-tag review against the current single-tag-per-hash
   scheme (tags 1–8 in `circuits/*.circom`), constraint-count delta.
7. **Threshold auditing (t-of-n) vs. the single auditor key** — `compliance.move`'s ECDH auditor key
   is a single point of failure/coercion today. Price a threshold-ECDSA or Shamir-split alternative.
8. **Mobile WASM proving latency** — extend `scripts/bench/browser-bench.mjs` with a throttled-CPU
   Chromium profile (or a real device) once `transfer`/`compliance` are wired into the frontend.
9. **Circuit soundness sweep** — under-constrained signal search, alias checks, nullifier-collision
   analysis across all three circuits using static analysis tooling (e.g. circomspect) rather than
   manual review.
10. **Post-quantum exposure** — BN254 discrete-log assumption is the whole soundness basis today;
    write down exactly what breaks under a quantum adversary and what a STARK-based fallback would
    cost against `BASELINE.md`.
11. **Relayer throughput and leakage under load** — `scripts/src/relayer.ts` rate-limits at
    10 req/min/IP; never measured what an attacker actually learns about transfer timing/volume by
    watching relayer response latency under concurrent load.

## Settled (see LEDGER.md for the full history)

- `docs/research/BASELINE.md` — circuit constraints, proving time, proof/VK size, browser latency:
  **KEEP**. On-chain gas dimension: **BLOCKED**, requeued as #1 above.
