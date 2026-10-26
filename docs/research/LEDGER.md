# Research ledger

Append-only. One row per night. Never edit or delete a past row — if an experiment gets rerun,
add a new row and say why in the notes; don't overwrite history.

| Date | Slug | Hypothesis | Verdict | Notes |
|---|---|---|---|---|
| 2026-07-22 | `baseline-measurement` | Every core Veil performance number (constraints, zkey/vk/proof size, Node + browser proving time) can be measured directly on one machine with real command output, not estimated. | **KEEP** (partial) | First run of this loop — bootstrapped `docs/research/` itself (this ledger, the queue, `NIGHTLY_PROMPT.md`) alongside the experiment. `BASELINE.md` created. All three circuits measured end-to-end (constraints, zkey/vk size, Node + browser proving time via a real headless-Chromium run). On-chain gas per entry point is **BLOCKED**: no `sui` CLI available or buildable within budget, and a fallback JSON-RPC read against the deployed testnet package was denied by the sandbox's tool-approval layer mid-session (not retried, per policy). Full writeup: [`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md). |
| 2026-10-26 | `toolchain-blocked` | Unblock gas measurement (#1) or, failing that, measure Poseidon2 vs Poseidon (#2). | **BLOCKED** | No measurement. Sui RPC / GitHub releases / crates.io denied by egress proxy (403); `cargo build` of `iden3/circom` v2.2.2 denied by the sandbox approval layer, so no circuits could be compiled. Not routed around. Needs allowlist and/or circom preinstalled. Report: [`2026-10-26-toolchain-blocked.md`](2026-10-26-toolchain-blocked.md). |
