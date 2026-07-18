# BASELINE.md — Veil's measured numbers

The fixed reference every future entry in `docs/research/` diffs against. Established
2026-07-18 (`2026-07-18-baseline-measurement.md`), on one machine, in one run, from
`origin/main` at `b1ca081`. Every number below came from a command that was actually run; the
raw output lives in the dated report. **Do not add a number here that wasn't measured this way**
— extend this file only from a dated report in this directory with its own raw output.

Machine: Intel Xeon @ 2.10GHz, 4 vCPU, 15GiB RAM, Linux x86_64.
Toolchain: Node v22.22.2, circom2 0.2.23 (wraps circom compiler 2.2.3, WASM build — no native
`circom` binary was available in the measuring environment), snarkjs 0.7.6.

## Circuit constraints (`snarkjs r1cs info`)

| Circuit | Non-linear | Linear | Total constraints | Public / private inputs |
|---|---:|---:|---:|---|
| `transfer.circom` | 6,470 | 7,141 | 13,611 | 7 / 47 |
| `compliance.circom` | 6,057 | 6,686 | 12,743 | 6 / 45 |
| `withdraw.circom` | 1,465 | 1,593 | 3,058 | 5 / 5 |

## Groth16 proving (Node.js, 5 runs each, dev-only fresh trusted setup)

| Circuit | Mean prove | Min | Max | Proof (JSON) | VK | zkey | WASM |
|---|---:|---:|---:|---:|---:|---:|---:|
| `transfer` | 966.4 ms | 834.3 ms | 1236.4 ms | 723 B | 4,022 B | 6,001,427 B | 2,846,127 B |
| `compliance` | 914.5 ms | 817.1 ms | 1009.9 ms | 721 B | 3,839 B | 5,682,162 B | 2,931,887 B |
| `withdraw` | 279.6 ms | 262.8 ms | 292.6 ms | 723 B | 3,655 B | 1,385,340 B | 2,346,258 B |

On-chain proof format (after `scripts/src/proof-converter.ts` packing) is 128 bytes — separate
from the JSON sizes above, which are the pre-conversion snarkjs output.

## Browser (real WASM) proving latency — `transfer.circom`, headless Chromium, same machine

| | Time |
|---|---:|
| First proof (cold: WASM fetch + compile + instantiate) | 2616.6 ms |
| Second proof (warm) | 1384.7 ms |
| Third proof (warm) | 1458.1 ms |

Desktop-class CPU, not mobile. Mobile latency is `EXPERIMENTS.md` #8, unmeasured.

## On-chain gas per entry point

**UNMEASURED.** No `sui` CLI reachable in the measuring session (GitHub access scoped to
`alexandre-mrt/veil` only; no crates.io/npm distribution of the real binary; no already-deployed
instance to dry-run against via RPC). Unblock condition and path: `EXPERIMENTS.md` #1.

## Test suite (green, except the one blocked suite)

| Suite | Result |
|---|---|
| `transfer.circom` (real Groth16) | 43 pass |
| `compliance.circom` (real Groth16) | 30 pass |
| `withdraw.circom` (real Groth16) | 35 pass |
| Proof converter | 109 pass |
| Compliance utils | 67 pass |
| Fuzz (fast-check, 6 properties × 500 cases) | all pass |
| Frontend (vitest) | 19 pass |
| Move (`sui move test`) | not run — no `sui` CLI available |

## Reproduce

```bash
cd circuits && npm install
npx circom2 transfer.circom   --r1cs --wasm --sym --output build            -l node_modules
npx circom2 compliance.circom --r1cs --wasm --sym --output build-compliance -l node_modules
npx circom2 withdraw.circom   --r1cs --wasm --sym --output build-withdraw   -l node_modules
curl -L -o build/pot15_final.ptau https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau
# per circuit: snarkjs groth16 setup <r1cs> build/pot15_final.ptau <name>_0000.zkey
#              snarkjs zkey contribute <name>_0000.zkey <name>_final.zkey --name=<x> -v
#              snarkjs zkey export verificationkey <name>_final.zkey <name>_vk.json
node scripts/bench/prove-bench.mjs --runs 5
node scripts/bench/browser-prove-bench.mjs --runs 3
```
