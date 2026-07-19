# Veil baseline — measured on one machine, one run

Every number below came from a command that was actually run, in this sandbox, on 2026-07-19.
Raw output lives in `docs/research/2026-07-19-baseline.md`. This file is the number sheet;
that file is the write-up (hypothesis, threat model, approach, verdict).

Re-measure with `scripts/bench/prove-latency.mjs` (Node/CLI proving) and
`scripts/bench/browser-prove.mjs` (Chromium proving) — both take the exact command they used
from their own source, not from this file.

## Machine

- CPU: Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU
- RAM: 15 GiB
- OS: Linux, node v22.22.2
- circom: `@distributedlab/circom2` 0.2.22-rc.1 (WASM build of circom compiler 2.2.2) —
  the native Rust `circom` binary could not be installed in this sandbox; see the BLOCKED note
  in the research report for why.
- snarkjs: 0.7.6

## Circuit constraints (`snarkjs r1cs info`)

| Circuit | R1CS constraints | Non-linear | Linear | Public / private inputs |
|---|---|---|---|---|
| `transfer.circom` | 13,611 | 6,470 | 7,141 | 7 / 47 |
| `compliance.circom` | 12,743 | 6,057 | 6,686 | 6 / 45 |
| `withdraw.circom` | 3,058 | 1,465 | 1,593 | 5 / 5 |

Matches the counts already published in README.md exactly — this run is an independent
re-derivation on a fresh machine, not a copy.

## Groth16 trusted setup (pot15, dev single-contributor ceremony)

| Circuit | `groth16 setup` wall time | `.zkey` size | `_vk.json` size |
|---|---|---|---|
| `transfer.circom` | 8.9s | 6,001,422 bytes | 4,023 bytes |
| `compliance.circom` | 9.1s | 5,682,146 bytes | 3,838 bytes |
| `withdraw.circom` | — (not separately timed) | 1,385,326 bytes | 3,653 bytes |

## Proving latency — Node/CLI (`scripts/bench/prove-latency.mjs --runs 10`)

| Circuit | Prove mean | Prove min–max | Verify mean | `proof.json` | `.wasm` |
|---|---|---|---|---|---|
| `transfer.circom` | 905.0ms | 836.9–1201.7ms | 27.3ms | 723 bytes | 2,777,293 bytes |
| `compliance.circom` | 829.8ms | 800.1–863.6ms | 25.9ms | 721 bytes | 2,862,136 bytes |
| `withdraw.circom` | 264.5ms | 254.8–278.6ms | 18.9ms | 723 bytes | 2,298,257 bytes |

## Proving latency — headless Chromium (`scripts/bench/browser-prove.mjs`, `transfer.circom` only, 10 runs)

| | Prove mean | Prove min–max | Verify mean |
|---|---|---|---|
| Browser (snarkjs.min.js UMD, same wasm/zkey) | 1310.8ms | 1233.0–1463.0ms | 17.7ms |
| Node (same input, same artifacts) | 905.0ms | 836.9–1201.7ms | 27.3ms |

Browser proving is ~1.4x slower than Node for the same circuit and artifacts on this machine —
this is a WASM-in-browser-engine vs WASM-in-Node overhead, not a circuit-size effect (same wasm
file both ways). Two earlier 5-run invocations of the browser harness returned means of 1852.8ms
and 1349.7ms respectively — a real ~40% run-to-run swing on this shared, noisy sandbox VM. The
10-run number above is the one to trust; treat single 5-run browser samples on shared hardware as
noisy. compliance.circom and withdraw.circom were not benchmarked in-browser this run (scope
decision, see report "Approach" — extending the harness to the other two circuits is mechanical,
just not done tonight).

## Test suite (2026-07-19)

| Suite | Result | Command |
|---|---|---|
| `transfer.circom` (real Groth16) | 43 pass | `node --experimental-vm-modules test/transfer.test.mjs` |
| `compliance.circom` (real Groth16) | 30 pass | `node --experimental-vm-modules test/compliance.test.mjs` |
| `withdraw.circom` (real Groth16) | 35 pass | `node --experimental-vm-modules test/withdraw.test.mjs` |
| Proof converter | 109 pass | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils | 67 pass | `cd scripts && bun run src/test-compliance-utils.ts` |
| Property-based fuzz | 6 properties × 500 cases, all pass | `cd scripts && bun run src/fuzz-tests.ts` |
| Frontend (vitest) | 19 pass | `cd frontend && bunx vitest run` |
| Move contract | **BLOCKED** | `cd contracts && sui move test` |

Every non-blocked suite matches the count already claimed in README.md exactly (43+30+35 circuit,
109 converter, 67 compliance-utils, 19 frontend, 6×500 fuzz) — this is an independent
re-verification on a fresh machine, not a copy of the claim.

## BLOCKED

- **On-chain gas per entry point.** No `sui` CLI binary in this sandbox: it is not published on
  crates.io under a real package (only a 0.0.1 name-squat with no deps), and its source
  (`github.com/MystenLabs/sui`) is on a host this sandbox's egress policy returns 403 for. Direct
  JSON-RPC to `fullnode.testnet.sui.io` is blocked by the same policy (403 on CONNECT). `contracts/Move.toml`
  also pulls the Sui framework via a `git = "https://github.com/MystenLabs/sui.git"` dependency, so
  even `sui move test` (not just gas measurement) is unreachable here independent of the CLI issue.
- **`compliance.circom` / `withdraw.circom` browser proving latency.** Only `transfer.circom` was
  wired into the browser harness this run.
