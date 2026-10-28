# Research ledger

Append-only. One row per night. Never edit or delete a past row — if an experiment gets rerun,
add a new row and say why in the notes; don't overwrite history.

| Date | Slug | Hypothesis | Verdict | Notes |
|---|---|---|---|---|
| 2026-07-22 | `baseline-measurement` | Every core Veil performance number (constraints, zkey/vk/proof size, Node + browser proving time) can be measured directly on one machine with real command output, not estimated. | **KEEP** (partial) | First run of this loop — bootstrapped `docs/research/` itself (this ledger, the queue, `NIGHTLY_PROMPT.md`) alongside the experiment. `BASELINE.md` created. All three circuits measured end-to-end (constraints, zkey/vk size, Node + browser proving time via a real headless-Chromium run). On-chain gas per entry point is **BLOCKED**: no `sui` CLI available or buildable within budget, and a fallback JSON-RPC read against the deployed testnet package was denied by the sandbox's tool-approval layer mid-session (not retried, per policy). Full writeup: [`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md). |
| 2026-10-28 | `gas-toolchain-unblock` | A prebuilt `sui` CLI can be obtained in the sandbox and used to measure gas per entry point and run the Move suite. | **BLOCKED** | Release tarball downloads fine (837 MB, contains `sui`), but executing it was denied by the sandbox classifier; testnet fullnode RPC returns CONNECT 403. No numbers measured. Needs owner to allow running the binary or egress to the fullnode. Full writeup: [`2026-10-28-gas-toolchain-unblock.md`](2026-10-28-gas-toolchain-unblock.md). |
