# Research ledger

Append-only. One row per night. Never edit or delete a past row — if an experiment gets rerun,
add a new row and say why in the notes; don't overwrite history.

| Date | Slug | Hypothesis | Verdict | Notes |
|---|---|---|---|---|
| 2026-07-22 | `baseline-measurement` | Every core Veil performance number (constraints, zkey/vk/proof size, Node + browser proving time) can be measured directly on one machine with real command output, not estimated. | **KEEP** (partial) | First run of this loop — bootstrapped `docs/research/` itself (this ledger, the queue, `NIGHTLY_PROMPT.md`) alongside the experiment. `BASELINE.md` created. All three circuits measured end-to-end (constraints, zkey/vk size, Node + browser proving time via a real headless-Chromium run). On-chain gas per entry point is **BLOCKED**: no `sui` CLI available or buildable within budget, and a fallback JSON-RPC read against the deployed testnet package was denied by the sandbox's tool-approval layer mid-session (not retried, per policy). Full writeup: [`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md). |
| 2026-09-30 | `poseidon2-constraint-cost` | Swapping every circomlib Poseidon in `transfer.circom` for Poseidon2 (t∈{2,3,4}) cuts its constraint count ≥15% (baseline 13,611). | **REJECT** | Measured −3.0% transfer (13,611→13,206), −12.2% withdraw, **+2.9%** compliance (leaf `Poseidon(5)` needs 2 permutations). Structural shim, placeholder constants; proving time not measured. Side finding: `MerkleProof(20)` = 76% of transfer's constraints (520/level). Queue #1 (gas) attempted first and still **BLOCKED** — Sui fullnode + release hosts denied by network policy. Report: [`2026-09-30-poseidon2-constraint-cost.md`](2026-09-30-poseidon2-constraint-cost.md). |
