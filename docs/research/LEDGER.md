# Research ledger

Append-only. One row per night. Never edit or delete a past row — if an experiment gets rerun,
add a new row and say why in the notes; don't overwrite history.

| Date | Slug | Hypothesis | Verdict | Notes |
|---|---|---|---|---|
| 2026-07-22 | `baseline-measurement` | Every core Veil performance number (constraints, zkey/vk/proof size, Node + browser proving time) can be measured directly on one machine with real command output, not estimated. | **KEEP** (partial) | First run of this loop — bootstrapped `docs/research/` itself (this ledger, the queue, `NIGHTLY_PROMPT.md`) alongside the experiment. `BASELINE.md` created. All three circuits measured end-to-end (constraints, zkey/vk size, Node + browser proving time via a real headless-Chromium run). On-chain gas per entry point is **BLOCKED**: no `sui` CLI available or buildable within budget, and a fallback JSON-RPC read against the deployed testnet package was denied by the sandbox's tool-approval layer mid-session (not retried, per policy). Full writeup: [`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md). |
| 2026-11-04 | `onchain-gas-blocked` | Gas per entry point can be measured via a local `sui` CLI + localnet. | **BLOCKED** | Fullnode RPC 403 at proxy (both nets). Prebuilt `sui` v1.60.0 downloads via the GitHub release asset URL (837 MB, sha256 recorded) but execution was denied by the permission classifier (external binary); not bypassed. No gas number produced. Unblock: approve the binary or bake `sui` into the environment. Report: [`2026-11-04-onchain-gas-blocked.md`](2026-11-04-onchain-gas-blocked.md). |
