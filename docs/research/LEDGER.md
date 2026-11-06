# Research ledger

Append-only. One row per night. Never edit or delete a past row — if an experiment gets rerun,
add a new row and say why in the notes; don't overwrite history.

| Date | Slug | Hypothesis | Verdict | Notes |
|---|---|---|---|---|
| 2026-07-22 | `baseline-measurement` | Every core Veil performance number (constraints, zkey/vk/proof size, Node + browser proving time) can be measured directly on one machine with real command output, not estimated. | **KEEP** (partial) | First run of this loop — bootstrapped `docs/research/` itself (this ledger, the queue, `NIGHTLY_PROMPT.md`) alongside the experiment. `BASELINE.md` created. All three circuits measured end-to-end (constraints, zkey/vk size, Node + browser proving time via a real headless-Chromium run). On-chain gas per entry point is **BLOCKED**: no `sui` CLI available or buildable within budget, and a fallback JSON-RPC read against the deployed testnet package was denied by the sandbox's tool-approval layer mid-session (not retried, per policy). Full writeup: [`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md). |
| 2026-11-06 | `gas-localnet` | Gas per entry point can be measured on a local Sui network, and per-verify computation is large enough that batching would cut per-transfer gas. | **KEEP** (partial) | Prebuilt `sui` 1.83.1 unblocked the toolchain; Move tests 124/124. 10 entry points measured on localnet. Batching premise refuted: computation is at the 1,000,000 MIST floor even for a full Groth16 verify. Verify rows use a garbage proof (circom/ptau build denied by the permission classifier) so successful-transfer storage and `compliant_transfer` remain unmeasured. [Report](2026-11-06-gas-localnet.md). |
