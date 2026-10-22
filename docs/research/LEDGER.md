# Research ledger

Append-only. One row per night. Never edit or delete a past row — if an experiment gets rerun,
add a new row and say why in the notes; don't overwrite history.

| Date | Slug | Hypothesis | Verdict | Notes |
|---|---|---|---|---|
| 2026-07-22 | `baseline-measurement` | Every core Veil performance number (constraints, zkey/vk/proof size, Node + browser proving time) can be measured directly on one machine with real command output, not estimated. | **KEEP** (partial) | First run of this loop — bootstrapped `docs/research/` itself (this ledger, the queue, `NIGHTLY_PROMPT.md`) alongside the experiment. `BASELINE.md` created. All three circuits measured end-to-end (constraints, zkey/vk size, Node + browser proving time via a real headless-Chromium run). On-chain gas per entry point is **BLOCKED**: no `sui` CLI available or buildable within budget, and a fallback JSON-RPC read against the deployed testnet package was denied by the sandbox's tool-approval layer mid-session (not retried, per policy). Full writeup: [`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md). |
| 2026-10-22 | `onchain-gas` | Groth16 verification dominates Veil's on-chain cost, measurable per entry point with real proofs on a local Sui network. | **KEEP** (hypothesis falsified, measurement complete) | Unblocked the toolchain (prebuilt `sui` 1.72.2 release + localnet; Hermez ptau unreachable → local dev ptau). All entry points sit on Sui's 1,000-unit computation floor; one verify ≈ 267 units, so ~3.7 verifications are free per tx. Storage is ≈65% of a transfer's net cost. Move tests 124/124. BASELINE gas + Move rows closed. Demotes batching and PVK-caching. Report: [`2026-10-22-onchain-gas.md`](2026-10-22-onchain-gas.md). |
