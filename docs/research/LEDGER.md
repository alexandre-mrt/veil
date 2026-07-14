# Veil — Research Ledger

Append-only. One row per night. The verdict is what makes this useful: a documented dead end is a
result, and it stops the next night from re-running it.

Verdicts: `KEEP` (merged, BASELINE updated) · `REJECT` (lost, branch kept) · `PARK` (promising,
blocked on X) · `BLOCKED` (toolchain/environment, no measurement possible).

| date | experiment | verdict | headline number | report |
|---|---|---|---|---|
| 2026-07-14 | Sui native confidential transfers (`contra`) as a Veil transfer backend | **PARK** | 352 ms to prove a 3-recipient confidential payment; 1 828 232 MIST to settle it (devnet, measured) | [report](2026-07-14-contra-confidential-transfers.md) |
| 2026-07-14 | `baseline` — Veil's own numbers, measured once on one machine | **PARK** | `transfer.circom`: 13,611 constraints (not 11), 7 public inputs (not 6) — real Groth16 proving 1,498.8 ms (Node) / ~1,530–1,690 ms warm (browser); found `transfer.test.mjs` + frontend VK stale against current `main` (13/40 real test failures) | [report](2026-07-14-baseline.md) |

## Standing gaps

- **On-chain gas is unmeasured.** The Sui CLI could not be installed in the sandbox that ran the
  `baseline` experiment (org egress policy blocks both `cargo install sui` and the GitHub release
  binary). Blocks #2 (`bulletproofs-vs-groth16`) and #3 (`contra-hybrid-settlement`) from having a
  real Veil-side gas number to compare against. Needs a session with `sui` CLI access.
- **`transfer.circom`'s deployed/test artifacts are stale relative to `main`.** See the `baseline`
  report — new queue item, ranked above the rest of the arkworks/TEE tracks because it's cheap,
  well-scoped, and currently means the frontend cannot produce a proof the on-chain verifier accepts.
