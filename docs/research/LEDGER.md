# Veil research ledger

Append-only. One row per night. Never edit a past row's verdict — if an experiment deserves a
rematch, add a new row and say why in `EXPERIMENTS.md`.

| Date | Slug | Hypothesis | Verdict | Number moved | Report |
|---|---|---|---|---|---|
| 2026-07-17 | groth16-baseline | Veil's own circuit/proving/gas/latency numbers have never been measured together on one machine; establishing them turns every future comparison from half-blind to grounded. | KEEP (partial — on-chain gas and real-device browser latency BLOCKED, see report) | R1CS constraints (reproduced 13,611 / 12,743 / 3,058), Groth16 setup 10.3s/9.9s/3.4s, prove ~1.0-1.3s/~0.9-1.0s/~0.25-0.27s (Node, median), proof size 721-723 B, VK 3,655-4,025 B, headless-Chromium fullProve ~3.4s median (transfer) vs ~1.2-1.6s Node | [`2026-07-17-groth16-baseline.md`](2026-07-17-groth16-baseline.md) |
