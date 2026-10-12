# Research ledger

Append-only. One row per night. Never edit or delete a past row — if an experiment gets rerun,
add a new row and say why in the notes; don't overwrite history.

| Date | Slug | Hypothesis | Verdict | Notes |
|---|---|---|---|---|
| 2026-07-22 | `baseline-measurement` | Every core Veil performance number (constraints, zkey/vk/proof size, Node + browser proving time) can be measured directly on one machine with real command output, not estimated. | **KEEP** (partial) | First run of this loop — bootstrapped `docs/research/` itself (this ledger, the queue, `NIGHTLY_PROMPT.md`) alongside the experiment. `BASELINE.md` created. All three circuits measured end-to-end (constraints, zkey/vk size, Node + browser proving time via a real headless-Chromium run). On-chain gas per entry point is **BLOCKED**: no `sui` CLI available or buildable within budget, and a fallback JSON-RPC read against the deployed testnet package was denied by the sandbox's tool-approval layer mid-session (not retried, per policy). Full writeup: [`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md). |
| 2026-10-12 | `onchain-gas` | `shielded_transfer` gas is dominated by Groth16 verification, making batching worthwhile. | **BLOCKED** | UNMEASURED, no numbers. GitHub releases, public fullnode RPC and crates CDN all 403 at the egress proxy. `mysten/sui-tools` image was fetched via Docker Hub (allowed), but executing its `sui` binary was denied by the permission classifier; not retried. Needs permission to run a `sui` binary or an allow-listed fullnode. Report: [`2026-10-12-onchain-gas.md`](2026-10-12-onchain-gas.md). |
