# Research ledger

Append-only. One row per night. Never edit or delete a past row — if an experiment gets rerun,
add a new row and say why in the notes; don't overwrite history.

| Date | Slug | Hypothesis | Verdict | Notes |
|---|---|---|---|---|
| 2026-07-22 | `baseline-measurement` | Every core Veil performance number (constraints, zkey/vk/proof size, Node + browser proving time) can be measured directly on one machine with real command output, not estimated. | **KEEP** (partial) | First run of this loop — bootstrapped `docs/research/` itself (this ledger, the queue, `NIGHTLY_PROMPT.md`) alongside the experiment. `BASELINE.md` created. All three circuits measured end-to-end (constraints, zkey/vk size, Node + browser proving time via a real headless-Chromium run). On-chain gas per entry point is **BLOCKED**: no `sui` CLI available or buildable within budget, and a fallback JSON-RPC read against the deployed testnet package was denied by the sandbox's tool-approval layer mid-session (not retried, per policy). Full writeup: [`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md). |
| 2026-10-06 | `poseidon2-vs-poseidon` | Swapping circomlib `Poseidon(n)` for a t=3 Poseidon2 sponge cuts constraints and Node proving time by ≥10% in `transfer`/`withdraw`/`compliance`. | **REJECT** | Falsified by measurement: constraints +5.8% (transfer), +29.1% (withdraw), +0.02% (compliance); proving time within noise across two runs. Poseidon2 t=3 saves only 1.2% per Merkle level; 4-input hashes become two permutations. Merkle depth-20 is 75% of transfer's non-linear constraints. Queue #1 (gas) attempted first, still **BLOCKED** (sui binary + fullnode RPC both 403 via proxy). Report: [`2026-10-06-poseidon2-vs-poseidon.md`](2026-10-06-poseidon2-vs-poseidon.md). |
