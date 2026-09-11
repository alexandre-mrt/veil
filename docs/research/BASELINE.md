# Veil performance baseline

Measured 2026-07-22, on one machine, in one run. See
[`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md) for the full
methodology, raw command output, and what's still missing. Superseded rows should be replaced in
place with a note in `LEDGER.md` pointing at the experiment that changed them — this file always
reflects the current state of the protocol, not history.

Toolchain: circom 2.2.2 (built from source, `iden3/circom` tag `v2.2.2`), snarkjs 0.7.6, Node
v22.22.2, Chromium 141 (headless, via Playwright), pot15 Powers of Tau (Hermez, `2^15` — reused
for all three circuits per the existing `compile*.sh` scripts), single dev-only Groth16
contribution (matches `circuits/scripts/compile*.sh` — **not** a production ceremony; see
`ceremony.sh` and `docs/threat-model.md` RR2). On-chain gas (2026-09-11 addition below): `sui`
1.79.0 CLI, a local network (`sui start --with-faucet --force-regenesis`) — see that report for why
local-network gas is the same measurement as testnet/mainnet gas.

## Constraint counts, artifact sizes

| Circuit | R1CS constraints | Non-linear | Linear | Wires | Public / private inputs | zkey (bytes) | vk (bytes) | Compressed on-chain proof (bytes) |
|---|---|---|---|---|---|---|---|---|
| `transfer.circom` | 13,611 | 6,470 | 7,141 | 13,632 | 7 / 47 | 6,001,431 | 4,025 | 128 |
| `compliance.circom` | 12,743 | 6,057 | 6,686 | 12,762 | 6 / 45 | 5,682,155 | 3,841 | 128 |
| `withdraw.circom` | 3,058 | 1,465 | 1,593 | 3,058 | 5 / 5 | 1,385,335 | 3,656 | 128 |

Groth16 proofs are three fixed-size group elements (2×G1 + 1×G2) regardless of circuit — the
128-byte compressed on-chain figure (from `scripts/src/test-converter.ts`, `proofToSuiBytes`) is
constant across all three circuits. snarkjs's own JSON proof encoding (decimal-string field
elements) runs ~721–726 bytes for the same data.

## Proving time (mean of 10 runs, includes witness generation)

| Circuit | Node.js (this machine) | Chromium (headless, this machine) | Browser / Node ratio |
|---|---|---|---|
| `transfer.circom` | 751.9 ms (σ 17.3) | 1213.3 ms (σ 32.6, 8 runs) | 1.61x |
| `compliance.circom` | 738.1 ms (σ 20.9) | 1163.4 ms (σ 58.6, 8 runs) | 1.58x |
| `withdraw.circom` | 244.3 ms (σ 7.9) | 382.9 ms (σ 9.9, 8 runs) | 1.57x |

Reproduce: `node scripts/bench/prove-latency.mjs --runs 10` and
`node scripts/bench/browser-latency.mjs --runs 8` (see that directory for prerequisites).

## On-chain gas per entry point

Measured 2026-09-11, on a real local Sui network (`sui 1.79.0`, `sui start --with-faucet
--force-regenesis`) — see
[`2026-09-11-onchain-gas-baseline.md`](2026-09-11-onchain-gas-baseline.md) for the full
methodology and raw output. Local-network gas equals testnet/mainnet gas for identical bytecode
and inputs (deterministic VM execution against a fixed price schedule); only the reference gas
price (1000 MIST/unit here, queried live via `suix_getReferenceGasPrice`) can differ by network.

| Entry point | Computation (MIST) | Storage (MIST) | Rebate (MIST) | Net (MIST) | Net (SUI) |
|---|---:|---:|---:|---:|---:|
| `publish` (package + `TreasuryCap`) | 1,380,000 | 156,415,600 | 5,868,720 | 151,926,880 | 0.151927 |
| `create_pool` | 1,000,000 | 8,496,800 | 978,120 | 8,518,680 | 0.008519 |
| `propose_withdraw_vk` | 1,000,000 | 11,726,800 | 8,411,832 | 4,314,968 | 0.004315 |
| `token_faucet::faucet` | 1,000,000 | 4,043,200 | 2,678,544 | 2,364,656 | 0.002365 |
| `deposit_and_register` | 1,000,000 | 13,588,800 | 11,421,432 | 3,167,368 | 0.003167 |
| `update_commitment_root` | 1,000,000 | 11,970,000 | 11,609,532 | 1,360,468 | 0.001360 |
| `shielded_transfer` (real Groth16 proof) | 1,000,000 | 14,242,400 | 12,369,456 | 2,872,944 | 0.002873 |
| `freeze_pool` | 1,000,000 | 11,726,800 | 11,609,532 | 1,117,268 | 0.001117 |
| `unfreeze_pool` | 1,000,000 | 11,726,800 | 11,609,532 | 1,117,268 | 0.001117 |
| `zk_withdraw` (real Groth16 proof) | 1,000,000 | 15,580,000 | 12,128,688 | 4,451,312 | 0.004451 |

Computation gas is a flat 1,000,000 MIST (the minimum bucket) for every call except `publish` —
Groth16 verification costs the same regardless of circuit size (three pairing checks either way),
so the 4.4x constraint-count gap and 3.1x proving-time gap between `transfer.circom` and
`withdraw.circom` (see Proving time, above) show up nowhere in on-chain gas. Storage — specifically
dynamic-field churn on the shared `Pool` object — dominates every number instead.

Reproduce: `cd scripts && bun run bench/onchain-gas.ts` against a local network started with
`sui genesis -f --with-faucet && sui start --with-faucet --force-regenesis` (see the linked report
for the full toolchain setup, including circuit compilation).

Compliant-transfer (dual-proof) gas was not measured — queued, see
`2026-09-11-onchain-gas-baseline.md` Open questions.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Compliant-transfer (dual-proof) gas | **NOT MEASURED** | Needs a `ComplianceConfig` + seeded credential Merkle tree in addition to the base entry points measured 2026-09-11; didn't fit in that night. Queued. |
| Gas under shared-object contention (concurrent callers) | **NOT MEASURED** | 2026-09-11's numbers are for uncontended, sequential calls only. Queued as a scalability experiment. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future measurement should replace the corresponding row above in place,
not be appended as a separate table.

## Move contract test suite

**124/124 pass** (`cd contracts && sui move test --build-env testnet`) — confirmed for real
2026-09-11, matching `README.md`'s claimed count. Not run in the 2026-07-22 baseline for lack of a
`sui` CLI.
