# Veil performance baseline

Measured together, on one machine, for the first time on 2026-07-17. Full methodology, raw command
output, and caveats: [`docs/research/2026-07-17-groth16-baseline.md`](docs/research/2026-07-17-groth16-baseline.md).
Reproduce with `circuits/scripts/compile*.sh` (build artifacts) then `scripts/bench/groth16-bench.mjs`
and `scripts/bench/browser-harness/serve-and-bench.mjs`.

Every number below was measured, not estimated. Where a number couldn't be measured in this sandbox,
it says so — it is not filled in with a guess.

## Circuits

| Circuit | R1CS constraints | Non-linear | Linear | Public / private inputs | R1CS file size |
|---|---|---|---|---|---|
| `transfer.circom` | 13,611 | 6,470 | 7,141 | 7 / 47 | 1,851,820 B |
| `compliance.circom` | 12,743 | 6,057 | 6,686 | 6 / 45 | 1,726,984 B |
| `withdraw.circom` | 3,058 | 1,465 | 1,593 | 5 / 5 | 436,320 B |

Reproduce: `cd circuits && circom transfer.circom --r1cs --wasm --sym -o build && npx snarkjs r1cs info build/transfer.r1cs` (same for `compliance.circom` → `build-compliance/`, `withdraw.circom` → `build-withdraw/`).

## Groth16 setup (dev, single contribution, pot15 Powers of Tau)

| Circuit | Setup time |
|---|---|
| `transfer` | 10.3 s |
| `compliance` | 9.9 s |
| `withdraw` | 3.4 s |

## Proving (Node.js, `snarkjs` 0.7.6, median of 5 runs — this sandbox's CPU is noisy, see the report for raw per-run numbers)

| Circuit | Witness gen | Prove | Verify | Proof size | VK size | Final zkey size |
|---|---|---|---|---|---|---|
| `transfer` | ~120–310 ms | ~1,000–1,300 ms | ~36–40 ms | 722–723 B | 4,025 B | 6,001,424 B |
| `compliance` | ~107–126 ms | ~900–960 ms | ~18–42 ms | 722–723 B | 3,840 B | 5,682,148 B |
| `withdraw` | ~68–72 ms | ~254–265 ms | ~34–38 ms | 721–723 B | 3,655 B | 1,385,328 B |

## Browser proving (headless Chromium via Playwright, `transfer.circom`, real `snarkjs` WASM bundle)

| | Node (witness + prove) | Headless Chromium (fullProve = witness + prove) |
|---|---|---|
| Median | ~1,200–1,600 ms | ~3,400 ms |
| Min–max (5 runs) | ~1,050–2,900 ms | 1,439–10,665 ms |

**Not a mobile-device number.** This is headless Chromium on the same shared sandbox VM as the Node
benchmark — useful as a same-machine Node-vs-browser comparison, not as a phone UX number. Real-device
measurement is open (queue item 3, `docs/research/EXPERIMENTS.md`).

## On-chain gas per entry point — not measured

**BLOCKED.** No `sui` CLI in this sandbox; GitHub release-asset downloads are denied by the outbound
egress policy (403, policy-classified); building the ~1,615-crate Sui monorepo from source was judged
infeasible for a single night. Tracked as queue item 2 in `docs/research/EXPERIMENTS.md`. Do not
substitute an estimate here — when this gets measured, it replaces this paragraph with a real number
and the exact `sui client call --gas-budget ...` (or equivalent) command that produced it.

## What's NOT in this baseline yet

- On-chain gas, all entry points (`shielded_transfer`, `compliant_transfer`, `deposit`, `withdraw`,
  `zk_withdraw`) — blocked, see above.
- Real-device (phone) browser proving latency — blocked, see above; headless-Chromium number above is
  a same-machine proxy, not a substitute.
- Shared-object contention under concurrent transfers — depends on the gas/sui-CLI blocker.
- Merkle accumulator behavior at scale (10^5–10^7 commitments) — not attempted this run.

Update this file whenever a KEEP-verdict experiment changes one of these numbers. Do not let it drift
from what `docs/research/LEDGER.md` records as measured.
