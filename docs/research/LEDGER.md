# Research Ledger

Append-only. One row per night. Never edit or delete a past row — if a verdict needs revisiting,
add a new row that supersedes it and say so in Notes.

| Date | Slug | Hypothesis (one line) | Verdict | Number that moved | Notes |
|---|---|---|---|---|---|
| 2026-07-18 | baseline-measurement | Veil's own circuit/proving/artifact/browser numbers can be measured in one run on one machine and fixed as the reference `BASELINE.md` | KEEP (partial) | transfer 13,611 constraints / 966ms mean prove / 723B proof; compliance 12,743 / 915ms / 721B; withdraw 3,058 / 280ms / 723B; browser transfer proof 1.4–2.6s (Chromium, 4 vCPU) | On-chain gas per entry point: **BLOCKED** — no `sui` CLI reachable in session (GitHub access scoped to `alexandre-mrt/veil` only; no crates.io/npm distribution of the real binary; nothing deployed to dry-run against). Requeued as EXPERIMENTS.md #1. Full report: `2026-07-18-baseline-measurement.md`. |
