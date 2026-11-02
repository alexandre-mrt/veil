# Research ledger

Append-only. One row per night. Never edit or delete a past row — if an experiment gets rerun,
add a new row and say why in the notes; don't overwrite history.

| Date | Slug | Hypothesis | Verdict | Notes |
|---|---|---|---|---|
| 2026-07-22 | `baseline-measurement` | Every core Veil performance number (constraints, zkey/vk/proof size, Node + browser proving time) can be measured directly on one machine with real command output, not estimated. | **KEEP** (partial) | First run of this loop — bootstrapped `docs/research/` itself (this ledger, the queue, `NIGHTLY_PROMPT.md`) alongside the experiment. `BASELINE.md` created. All three circuits measured end-to-end (constraints, zkey/vk size, Node + browser proving time via a real headless-Chromium run). On-chain gas per entry point is **BLOCKED**: no `sui` CLI available or buildable within budget, and a fallback JSON-RPC read against the deployed testnet package was denied by the sandbox's tool-approval layer mid-session (not retried, per policy). Full writeup: [`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md). |
| 2026-11-02 | `onchain-gas-per-entry-point` | `shielded_transfer` gas is dominated by Groth16 verification and measurably exceeds `zk_withdraw`/`deposit`. | **BLOCKED** | Third block on queue #1. Sui fullnodes 403 at the egress proxy, release binaries not served, from-source `cargo build -p sui` denied by the permission classifier (not worked around). No numbers produced. Needs: a Sui fullnode host allow-listed, or a prebuilt `sui`, or explicit approval for a source build. Report: [`2026-11-02-onchain-gas-per-entry-point.md`](2026-11-02-onchain-gas-per-entry-point.md). |
