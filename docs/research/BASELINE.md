# Veil performance baseline

Circuit/proving numbers measured 2026-07-22; on-chain gas numbers measured 2026-08-12; both on one
machine, in one run each. See [`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md)
and [`2026-08-12-onchain-gas-baseline.md`](2026-08-12-onchain-gas-baseline.md) for full methodology,
raw command output, and what's still missing. Superseded rows should be replaced in place with a
note in `LEDGER.md` pointing at the experiment that changed them — this file always reflects the
current state of the protocol, not history.

Toolchain: circom 2.2.2 (built from source, `iden3/circom` tag `v2.2.2`), snarkjs 0.7.6, Node
v22.22.2, Chromium 141 (headless, via Playwright), pot15 Powers of Tau (Hermez, `2^15` — reused
for all three circuits per the existing `compile*.sh` scripts), single dev-only Groth16
contribution (matches `circuits/scripts/compile*.sh` — **not** a production ceremony; see
`ceremony.sh` and `docs/threat-model.md` RR2).

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

Measured 2026-08-12 against a local single-validator Sui network (`sui start --force-regenesis`)
running `sui` 1.78.0 built from source — the deployed testnet package itself is unreachable from
this sandbox (network policy blocks all outbound calls to `fullnode.*.sui.io`), but the gas
*schedule* being measured is a property of the Sui binary, not of which network it's running
against. Reference gas price on this network: 1,000 MIST. Full methodology, the two-round
timelock dance the measurement required, and the computation-bucketing finding below:
[`2026-08-12-onchain-gas-baseline.md`](2026-08-12-onchain-gas-baseline.md).

| Entry point | Net MIST | Computation | Storage | Rebate |
|---|---|---|---|---|
| `pool::create_pool` | 8,518,680 | 1,000,000 | 8,496,800 | 978,120 |
| `pool::propose_withdraw_vk` | 4,314,968 | 1,000,000 | 11,726,800 | 8,411,832 |
| `pool::update_commitment_root` | 1,360,468 | 1,000,000 | 11,970,000 | 11,609,532 |
| `compliance::create_compliance_config` | 7,321,300 | 1,000,000 | 18,171,600 | 11,850,300 |
| `token_faucet::faucet` (mint) | 2,364,656 | 1,000,000 | 4,043,200 | 2,678,544 |
| `pool::deposit_and_register` | 3,172,232 | 1,000,000 | 14,075,200 | 11,902,968 |
| `pool::freeze_pool` / `unfreeze_pool` | 1,122,132 | 1,000,000 | 12,213,200 | 12,091,068 |
| `pool::shielded_transfer` | 2,875,376 | 1,000,000 | 14,485,600 | 12,610,224 |
| `pool::zk_withdraw` | 4,453,744 | 1,000,000 | 15,823,200 | 12,369,456 |
| `compliance::compliant_transfer` (dual Groth16 verify) | 5,047,760 | 1,000,000 | 22,556,800 | 18,509,040 |

Computation cost is identical (1,000,000 MIST = 1,000 computation units) across every entry point
above, including the dual-proof `compliant_transfer` — Sui's computation cost is bucketed, not
metered continuously, and every call measured here lands in the cheapest bucket. **Storage cost is
what actually determines net gas.** See the report for what this implies for queue item #3
(batched verification).

Reproduce: `sui start --force-regenesis --with-faucet &` then
`cd scripts && bun run bench/gas-bench.ts` (needs circuits compiled and a `sui` CLI on PATH — see
`circuits/scripts/compile*.sh`).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |
| Real testnet/mainnet reference gas price vs. this run's local-network default | **NOT MEASURED** | This run's 1,000 MIST reference price is `sui start`'s development default, not a queried live value (still unreachable — see above). The MIST numbers above scale linearly with reference price; the computation/storage ratio does not. |

Whatever comes out of a future measurement should replace the corresponding row above in place,
not be appended as a separate table.
