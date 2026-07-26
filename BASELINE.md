# Veil baseline numbers

Measured once, on one machine, in one run — see `docs/research/2026-07-26-baseline-measurements.md`
for the full methodology, raw command output, and what's still UNMEASURED. Every future experiment
in `docs/research/EXPERIMENTS.md` compares against this file. Update it only on a KEEP verdict that
changes one of these numbers; append the new measurement date, don't silently overwrite history —
git blame is the history.

**Last measured:** 2026-07-26, 4-core Intel Xeon @ 2.80GHz, Node v22.22.2, `snarkjs` 0.7.6,
`circom2` (WASM) 2.2.3 substituting for the native `circom` 2.1.x the README pins (native circom was
not installable in that sandbox — see the report for why).

## Circuit constraints (R1CS, via `snarkjs r1cs info`)

| Circuit | Non-linear | Linear | Total | Public / private inputs |
|---|---|---|---|---|
| `transfer.circom` | 6,470 | 7,141 | **13,611** | 7 / 47 |
| `compliance.circom` | 6,057 | 6,686 | **12,743** | 6 / 45 |
| `withdraw.circom` | 1,465 | 1,593 | **3,058** | 5 / 5 |

## Groth16 proving — Node.js (mean / median ms, N=10 trials, `scripts/bench/prove-bench.mjs`)

| Circuit | witness | prove | verify | total | proof | VK |
|---|---|---|---|---|---|---|
| `transfer` | 90.0 / 89.8 | 861.3 / 863.4 | 31.6 / 33.3 | **982.9 / 986.3** | 724 B | 4,024 B |
| `compliance` | 104.1 / 115.8 | 845.0 / 839.1 | 29.6 / 31.7 | **978.7 / 1,002.0** | 724 B | 3,838 B |
| `withdraw` | 76.3 / 70.1 | 259.2 / 258.5 | 27.6 / 28.7 | **363.1 / 357.4** | 724 B | 3,656 B |

## Groth16 `fullProve` — headless Chromium (mean / median ms, N=5 trials, `scripts/bench/run-browser-bench.mjs`)

Desktop headless Chromium via Playwright, **not mobile**. Measures `fullProve` (witness+prove
combined), matching the frontend's actual `useProofGeneration.ts` call.

| Circuit | fullProve | proof |
|---|---|---|
| `transfer` | 1,513.7 / 1,477.6 | 723 B |
| `compliance` | 1,619.2 / 1,512.4 | 718 B |
| `withdraw` | 685.7 / 644.8 | 722 B |

## On-chain gas per entry point — **UNMEASURED**

Blocked: no `sui` CLI reachable or installable, no route to Sui testnet RPC, from the sandbox this
baseline was measured in. See the report for both attempted paths and their exact failures. Tracked
as `docs/research/EXPERIMENTS.md` item #2.

## Real mobile-device WASM proving latency — **UNMEASURED**

No mobile device or throttled-mobile emulation available in that sandbox. Desktop headless-Chromium
numbers above should not be extrapolated to mobile without a documented throttling factor. Tracked as
`docs/research/EXPERIMENTS.md` item #8.

## Test suite (7 of 9 runnable without `sui` CLI)

| Suite | Result |
|---|---|
| `transfer.circom` (real Groth16) | 43/43 |
| `compliance.circom` (real Groth16) | 30/30 |
| `withdraw.circom` (real Groth16) | 35/35 |
| Proof converter | 109/109 |
| Compliance utils | 67/67 (~6 min wall-clock — see report, dense depth-20 tree materialization) |
| Property-based fuzz | 6/6 properties × 500 cases |
| Frontend (vitest) | 19/19 |
| Move contract (`sui move test`) | **BLOCKED** — no `sui` CLI |
| E2E (`e2e-test.ts`) | **BLOCKED** — no `sui` CLI |

## Reproduce

```bash
cd circuits && npm install
npx circom2 <name>.circom --r1cs --wasm --sym --output build -l node_modules   # transfer/compliance/withdraw
curl -L -o build/pot15_final.ptau https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau
npx snarkjs groth16 setup build/<name>.r1cs build/pot15_final.ptau build/<name>_0000.zkey
npx snarkjs zkey contribute build/<name>_0000.zkey build/<name>_final.zkey --name=x -v
npx snarkjs zkey export verificationkey build/<name>_final.zkey build/<name>_vk.json

cd ../scripts && bun install
node ../scripts/bench/prove-bench.mjs --circuit=<name> --trials=10 --warmup=2

# browser bench (from repo root):
npx http-server -p 8977 --cors -c-1 .   # separate terminal/process
node scripts/bench/run-browser-bench.mjs
```
