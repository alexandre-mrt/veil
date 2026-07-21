# BASELINE

Veil's own numbers, measured together on one machine, in one run, on 2026-07-21. See
`docs/research/2026-07-21-baseline.md` for the full experiment writeup (hypothesis, threat model,
raw command output, verdict). This file is the living reference other experiments diff against —
update it only when a KEEP verdict changes one of these numbers, and note the date/PR of the change.

Reproduce everything below with `scripts/bench/circuit-bench.mjs` and
`scripts/bench/browser-bench.mjs` (see each script's header for exact commands).

## Circuit size

| Circuit | R1CS constraints | Non-linear | Linear | Public / private inputs |
|---|---|---|---|---|
| `transfer.circom` | 13,611 | 6,470 | 7,141 | 7 / 47 |
| `compliance.circom` | 12,743 | 6,057 | 6,686 | 6 / 45 |
| `withdraw.circom` | 3,058 | 1,465 | 1,593 | 5 / 5 |

## Proving / verification — server-side (Node, native, median of 7 iterations)

| Circuit | Prove | Verify | Proof size | VK size | zkey size | wasm size |
|---|---|---|---|---|---|---|
| `transfer.circom` | 759.8 ms | 26.6 ms | 723 B | 4,025 B | 5.7 MB | 2.7 MB |
| `compliance.circom` | 715.3 ms | 24.9 ms | 721 B | 3,838 B | 5.4 MB | 2.8 MB |
| `withdraw.circom` | 237.4 ms | 23.7 ms | 724 B | 3,656 B | 1.3 MB | 2.2 MB |

## Proving — browser (headless Chromium via Playwright, `transfer.circom`, median of 5 iterations)

| Where | Prove (median) |
|---|---|
| Node (native) | 759.8 ms |
| Chromium/WASM, no Web Worker, single-threaded | 1,129.9 ms (~49% slower) |

Desktop-class container CPU, not mobile. First iteration pays one-time WASM module compile (2,187 ms);
steady-state iterations cluster near the median.

## On-chain gas per entry point

**UNMEASURED.** `sui` CLI unavailable this session (see `docs/research/2026-07-21-baseline.md` for the
exact blocker). Qualitative shape only, from reading `contracts/sources/pool.move` /
`compliance.move`: `shielded_transfer` = 1 Groth16 verify + 1 dynamic-field remove + 2 add;
`compliant_transfer` = 2 Groth16 verifies + 1 remove + 3 add + 1 ciphertext write;
`zk_withdraw` = 1 Groth16 verify + 1 remove + 2 add; `deposit_and_register` = 1 add, no proof.

## Environment this was measured on

- circom 2.2.3 (built from source, `iden3/circom` at the commit tagged for that release)
- snarkjs 0.7.6
- Node v22.22.2, linux x64
- Chromium 141.0.7390.37 (Playwright 1.56.1)
- 4 vCPU, 15 GB RAM container

## History

| Date | Change | PR |
|---|---|---|
| 2026-07-21 | Initial baseline established. All circuit-side numbers measured; gas BLOCKED. | research: 2026-07-21-baseline |
