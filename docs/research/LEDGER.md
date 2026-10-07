# Research ledger

Append-only. One row per night. Never edit or delete a past row — if an experiment gets rerun,
add a new row and say why in the notes; don't overwrite history.

| Date | Slug | Hypothesis | Verdict | Notes |
|---|---|---|---|---|
| 2026-07-22 | `baseline-measurement` | Every core Veil performance number (constraints, zkey/vk/proof size, Node + browser proving time) can be measured directly on one machine with real command output, not estimated. | **KEEP** (partial) | First run of this loop — bootstrapped `docs/research/` itself (this ledger, the queue, `NIGHTLY_PROMPT.md`) alongside the experiment. `BASELINE.md` created. All three circuits measured end-to-end (constraints, zkey/vk size, Node + browser proving time via a real headless-Chromium run). On-chain gas per entry point is **BLOCKED**: no `sui` CLI available or buildable within budget, and a fallback JSON-RPC read against the deployed testnet package was denied by the sandbox's tool-approval layer mid-session (not retried, per policy). Full writeup: [`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md). |
| 2026-10-07 | `onchain-gas` | `shielded_transfer` gas is dominated by Groth16 verify; hoisting `prepare_verifying_key` saves the ~82K claimed in `verifier.move`. | **BLOCKED** | Egress policy returns 403 for `fullnode.testnet.sui.io` and GitHub releases (proxy status logged `connect_rejected`); no `sui` CLI. No gas measured; structural inventory only, labelled UNMEASURED. The ~82K figure in `verifier.move` has no evidence behind it. Full writeup: [`2026-10-07-onchain-gas.md`](2026-10-07-onchain-gas.md). |
