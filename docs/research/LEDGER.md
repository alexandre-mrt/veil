# Research ledger

Append-only. One row per night. Never edit or delete a past row — if an experiment gets rerun,
add a new row and say why in the notes; don't overwrite history.

| Date | Slug | Hypothesis | Verdict | Notes |
|---|---|---|---|---|
| 2026-07-22 | `baseline-measurement` | Every core Veil performance number (constraints, zkey/vk/proof size, Node + browser proving time) can be measured directly on one machine with real command output, not estimated. | **KEEP** (partial) | First run of this loop — bootstrapped `docs/research/` itself (this ledger, the queue, `NIGHTLY_PROMPT.md`) alongside the experiment. `BASELINE.md` created. All three circuits measured end-to-end (constraints, zkey/vk size, Node + browser proving time via a real headless-Chromium run). On-chain gas per entry point is **BLOCKED**: no `sui` CLI available or buildable within budget, and a fallback JSON-RPC read against the deployed testnet package was denied by the sandbox's tool-approval layer mid-session (not retried, per policy). Full writeup: [`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md). |
| 2026-10-09 | `onchain-gas-unblock` | Each Veil entry point's gas can be measured locally with a `sui` CLI, and Groth16 verify dominates `shielded_transfer`. | **BLOCKED** | Third night blocked on queue item 1. GitHub/crates.io/fullnodes are denied by the egress proxy; a `sui` binary was recovered from Docker Hub image layers (`mysten/sui-tools:testnet`) but executing it was denied by the permission classifier and not circumvented. No measurement taken, `BASELINE.md` unchanged. Needs an owner decision on the unblock options. Full writeup: [`2026-10-09-onchain-gas-unblock.md`](2026-10-09-onchain-gas-unblock.md). |
