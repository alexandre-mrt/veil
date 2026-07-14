# Veil — Research Ledger

Append-only. One row per night. The verdict is what makes this useful: a documented dead end is a
result, and it stops the next night from re-running it.

Verdicts: `KEEP` (merged, BASELINE updated) · `REJECT` (lost, branch kept) · `PARK` (promising,
blocked on X) · `BLOCKED` (toolchain/environment, no measurement possible).

| date | experiment | verdict | headline number | report |
|---|---|---|---|---|
| 2026-07-14 | Sui native confidential transfers (`contra`) as a Veil transfer backend | **PARK** | 352 ms to prove a 3-recipient confidential payment; 1 828 232 MIST to settle it (devnet, measured) | [report](2026-07-14-contra-confidential-transfers.md) |

## Standing gaps

- **`BASELINE.md` does not exist yet.** Veil's own numbers (constraints, proving time, verify gas,
  proof size) have never been measured on one machine in one run. Until they are, every comparison
  against an alternative is half-blind — the contra experiment could measure contra's side but had
  nothing to compare it to. **This is the highest-priority next experiment.**
