# Research ledger

Append-only. One row per night. Never edit a past row's verdict — if an experiment deserves a
rematch, add a new row and say why in Notes, and re-rank it in `EXPERIMENTS.md`.

| Date | Slug | Hypothesis | Verdict | Key number | Notes |
|---|---|---|---|---|---|
| 2026-07-26 | baseline-measurements | Veil's per-circuit constraints, Groth16 proving time, proof/VK size, on-chain gas, and browser proving latency have never been measured together on one machine; establishing them turns every future experiment's "before/after" from a guess into a comparison. | **KEEP** (partial — see report) | transfer: 13,611 constraints / 982.9ms mean total (witness+prove+verify) / 724B proof; compliance: 12,743 / 978.7ms / 724B; withdraw: 3,058 / 363.1ms / 724B. Gas and real-device browser latency: **BLOCKED**, no `sui` CLI reachable from this sandbox. | First night. `docs/research/`, `CLAUDE.md`-equivalent context, and the nightly-loop scaffolding itself did not exist yet — created as part of this run. See bootstrap note in `NIGHTLY_PROMPT.md`. |
