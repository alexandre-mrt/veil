# Research ledger

Append-only. One row per night. Never edit a past row — if a verdict needs revisiting, add a new
row that says so and re-rank `EXPERIMENTS.md`.

| Date | Experiment | Hypothesis | Verdict | Number that moved | Report |
|---|---|---|---|---|---|
| 2026-07-19 | Baseline measurement | Veil's own circuit/proving/gas numbers have never been measured in one run on one machine; establishing them turns every future comparison from half-blind to grounded | KEEP (partial) — circuit constraints, proving time (Node + browser), proof/VK/wasm/zkey sizes measured directly; on-chain gas and Move test suite BLOCKED (no `sui` CLI or reachable Sui RPC/GitHub host under this sandbox's egress policy) | transfer.circom: 905.0ms Node prove / 1310.8ms browser prove (10-run mean, ~1.4x gap) | [2026-07-19-baseline.md](2026-07-19-baseline.md) |
