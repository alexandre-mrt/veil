# Research ledger

Append-only. One row per night. Never edit or delete a past row — if an experiment gets rerun,
add a new row and say why in the notes; don't overwrite history.

| Date | Slug | Hypothesis | Verdict | Notes |
|---|---|---|---|---|
| 2026-07-22 | `baseline-measurement` | Every core Veil performance number (constraints, zkey/vk/proof size, Node + browser proving time) can be measured directly on one machine with real command output, not estimated. | **KEEP** (partial) | First run of this loop — bootstrapped `docs/research/` itself (this ledger, the queue, `NIGHTLY_PROMPT.md`) alongside the experiment. `BASELINE.md` created. All three circuits measured end-to-end (constraints, zkey/vk size, Node + browser proving time via a real headless-Chromium run). On-chain gas per entry point is **BLOCKED**: no `sui` CLI available or buildable within budget, and a fallback JSON-RPC read against the deployed testnet package was denied by the sandbox's tool-approval layer mid-session (not retried, per policy). Full writeup: [`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md). |
| 2026-11-05 | `onchain-gas-baseline` | Real gas per Veil entry point is measurable on a local Sui network with a prebuilt CLI. | **KEEP** (partial) | Unblocked toolchain (sui v1.72.1 prebuilt; v1.60.0 can't compile the pinned framework). `sui move test` 124/124. Gas measured for publish, create_pool, deposit, admin ops (computation floor 1,000,000 MIST everywhere; deposit net 1,778,012). Proof-verifying entry points **BLOCKED**: circom build / npm install denied by permission layer. Report: [`2026-11-05-onchain-gas-baseline.md`](2026-11-05-onchain-gas-baseline.md). |
