# Veil — Research Ledger

Append-only. One row per night. The verdict is what makes this useful: a documented dead end is a
result, and it stops the next night from re-running it.

Verdicts: `KEEP` (merged, BASELINE updated) · `REJECT` (lost, branch kept) · `PARK` (promising,
blocked on X) · `BLOCKED` (toolchain/environment, no measurement possible).

| date | experiment | verdict | headline number | report |
|---|---|---|---|---|
| 2026-07-14 | Sui native confidential transfers (`contra`) as a Veil transfer backend | **PARK** | 352 ms to prove a 3-recipient confidential payment; 1 828 232 MIST to settle it (devnet, measured) | [report](2026-07-14-contra-confidential-transfers.md) |
| 2026-07-14 | `baseline` — Veil's own numbers, measured once on one machine | **PARK** | `transfer.circom`: 13,611 constraints (not 11), 7 public inputs (not 6) — real Groth16 proving 1,498.8 ms (Node) / ~1,530–1,690 ms warm (browser); found `transfer.test.mjs` + frontend VK stale against current `main` (13/40 real test failures) | [report](2026-07-14-baseline.md) |
| 2026-07-15 | `fix-stale-transfer-artifacts` — close the gap `baseline` found | **KEEP** | `transfer.test.mjs`: 27/40 → **42/42** real pass (full Groth16 mode); frontend `transfer_vk.json` regenerated (`nPublic` 6→7); `CLAUDE.md`/`docs/SPEC.md` corrected | [report](2026-07-15-fix-stale-transfer-artifacts.md) |

## Standing gaps

- **On-chain gas is unmeasured.** The Sui CLI could not be installed in the sandbox that ran the
  `baseline` experiment (org egress policy blocks both `cargo install sui` and the GitHub release
  binary), and this was reconfirmed independently on 2026-07-15 (`static.crates.io` still `403`;
  `cargo install --git https://github.com/MystenLabs/sui.git` times out cloning the monorepo). Blocks
  `bulletproofs-vs-groth16` and `contra-hybrid-settlement` from having a real Veil-side gas number to
  compare against. Needs a session with `sui` CLI access — do not re-attempt the identical blocked
  path again without a change in environment.
- **CI silently degrades circuit tests to a non-vacuous-but-still-simulated hash-only mode** whenever
  `circuits/build/` doesn't exist (fresh clone, `npm test` without a prior compile). This is exactly
  the root cause the 2026-07-15 fix closed for `transfer.circom` specifically; `compliance.circom` and
  `withdraw.circom` have the same two-mode test structure and are not currently forced into full-proof
  mode by any committed script. New queue item — see `2026-07-15-fix-stale-transfer-artifacts.md`
  Open Questions.
