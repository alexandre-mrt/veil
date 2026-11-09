# Research ledger

Append-only. One row per night. Never edit or delete a past row — if an experiment gets rerun,
add a new row and say why in the notes; don't overwrite history.

| Date | Slug | Hypothesis | Verdict | Notes |
|---|---|---|---|---|
| 2026-07-22 | `baseline-measurement` | Every core Veil performance number (constraints, zkey/vk/proof size, Node + browser proving time) can be measured directly on one machine with real command output, not estimated. | **KEEP** (partial) | First run of this loop — bootstrapped `docs/research/` itself (this ledger, the queue, `NIGHTLY_PROMPT.md`) alongside the experiment. `BASELINE.md` created. All three circuits measured end-to-end (constraints, zkey/vk size, Node + browser proving time via a real headless-Chromium run). On-chain gas per entry point is **BLOCKED**: no `sui` CLI available or buildable within budget, and a fallback JSON-RPC read against the deployed testnet package was denied by the sandbox's tool-approval layer mid-session (not retried, per policy). Full writeup: [`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md). |
| 2026-11-09 | `poseidon-arity` | Arity-4 depth-10 Merkle cuts transfer/compliance non-linear constraints ≥20 %; Poseidon2 at arity 2 changes them <2 %. | **BLOCKED** (design-only, UNMEASURED) | Gas (queue #1) still blocked: GitHub releases + Sui RPC return 403 from the egress proxy. Constraint measurement blocked too: `circom` not installed and the from-source build was denied by the auto-mode classifier. Analytic model only (`scripts/bench/constraint-model.mjs`): Poseidon2 ≈ −1 %, arity-4 ≈ −27 %. Also found: contracts do no on-chain Poseidon, so Merkle changes cost no gas. Report: [`2026-11-09-poseidon-arity.md`](2026-11-09-poseidon-arity.md). |
