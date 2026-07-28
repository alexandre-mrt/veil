# Veil — measured baseline

First-night baseline for the research loop (`docs/research/NIGHTLY_PROMPT.md`). Every number below
was produced by a command actually run on one machine in one sitting; the raw output and the exact
commands are in `docs/research/2026-07-28-groth16-baseline-benchmarks.md`. Update this file only when
a KEEP verdict changes one of these numbers — cite the report that changed it.

Reference machine: 4 vCPU (Intel Xeon @ 2.80GHz), 15 GiB RAM, Node v22.22.2, circom 2.2.3 (via the
`circom2` WASM build), snarkjs 0.7.6, headless Chromium 141 (Playwright). No GPU used.

## Circuit size (R1CS, `snarkjs r1cs info`)

| Circuit | Constraints | Non-linear | Public inputs | Private inputs | Wires |
|---|---|---|---|---|---|
| `transfer.circom` | 13,611 | 6,470 | 7 | 47 | 13,632 |
| `compliance.circom` | 12,743 | 6,057 | 6 | 45 | 12,762 |
| `withdraw.circom` | 3,058 | 1,465 | 5 | 5 | 3,058 |

Reproduces the README's numbers exactly — no drift between the claimed and the compiled circuit.

## Groth16 trusted setup (dev, single contributor, pot15)

| Circuit | Setup wall time | Final zkey size | vk.json size |
|---|---|---|---|
| `transfer.circom` | 9.34 s | 6,001,431 B (5.72 MiB) | 4,024 B |
| `compliance.circom` | 9.15 s | 5,682,157 B (5.42 MiB) | 3,837 B |
| `withdraw.circom` | 3.22 s | 1,385,335 B (1.32 MiB) | 3,655 B |

## Proving time — Node.js (server-side, `snarkjs.groth16.fullProve`, 5 runs)

| Circuit | Mean | Median | Min | Max | proof.json | Verified |
|---|---|---|---|---|---|---|
| `transfer.circom` | 970.5 ms | 911.3 ms | 869.6 ms | 1256.0 ms | 722 B | OK |
| `compliance.circom` | 862.1 ms | 846.2 ms | 831.0 ms | 895.1 ms | 724 B | OK |
| `withdraw.circom` | 283.2 ms | 282.4 ms | 270.9 ms | 292.2 ms | 722 B | OK |

## Proving time — browser (headless Chromium, WASM, 5 runs)

Only `withdraw.circom` is currently wired into the frontend's proving path, so it is the only one
measured this way tonight.

| Circuit | Mean (cold + 4 warm) | Warm mean (runs 2–5) | proof size | Verified |
|---|---|---|---|---|
| `withdraw.circom` | 682.3 ms | 514.9 ms | 722 B | OK |

`transfer`/`compliance` browser latency: **UNMEASURED** — not yet wired into the frontend's proving
flow, so there's no real page to drive. Mobile latency: **UNMEASURED** — no device/throttled-CPU
harness run yet.

## On-chain gas per entry point

**BLOCKED.** No `sui` CLI binary is available in the environment this baseline was measured in, and
none of the four Sui testnet JSON-RPC endpoints tried were reachable (sandboxed network egress
allowlist). See the report for exactly what was tried. Entry points still needing a gas number:
`pool::deposit_and_register`, `pool::shielded_transfer`, `pool::compliant_transfer`,
`pool::zk_withdraw`. Requeued as the top item in `EXPERIMENTS.md`.

## What this baseline is for

Every future KEEP/REJECT verdict in this loop should be read against these numbers, not against the
README's prose claims. If a PLONK/Halo2 migration, a batching scheme, or a Poseidon2 swap is
proposed, the report justifying it must show a before/after against this table — "faster" or
"cheaper" isn't a verdict without a number from here.
