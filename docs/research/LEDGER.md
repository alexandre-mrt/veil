# Research ledger

Append-only. One row per night. Never edit or delete a past row — if an experiment gets rerun,
add a new row and say why in the notes; don't overwrite history.

| Date | Slug | Hypothesis | Verdict | Notes |
|---|---|---|---|---|
| 2026-07-22 | `baseline-measurement` | Every core Veil performance number (constraints, zkey/vk/proof size, Node + browser proving time) can be measured directly on one machine with real command output, not estimated. | **KEEP** (partial) | First run of this loop — bootstrapped `docs/research/` itself (this ledger, the queue, `NIGHTLY_PROMPT.md`) alongside the experiment. `BASELINE.md` created. All three circuits measured end-to-end (constraints, zkey/vk size, Node + browser proving time via a real headless-Chromium run). On-chain gas per entry point is **BLOCKED**: no `sui` CLI available or buildable within budget, and a fallback JSON-RPC read against the deployed testnet package was denied by the sandbox's tool-approval layer mid-session (not retried, per policy). Full writeup: [`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md). |
| 2026-10-29 | `poseidon2-vs-merkle-arity` | Swapping circomlib Poseidon for Poseidon2 materially cuts `transfer` proving time (predicted: no, ≤3% non-linear constraints; 4-ary Merkle predicted ~27–28%). | **PARK** (UNMEASURED) | Gas (#1) BLOCKED a 3rd time: prebuilt `sui` v1.60.0 downloads but the sandbox refused to execute it; testnet RPC host refused by proxy. `circom` source build refused too, so nothing could be compiled. Design-only: closed-form constraint model reproduces measured 1,465 / 6,470 / 6,057 exactly; all Poseidon2 / 4-ary figures are UNMEASURED predictions. Report: [`2026-10-29-poseidon2-vs-merkle-arity.md`](2026-10-29-poseidon2-vs-merkle-arity.md). |
