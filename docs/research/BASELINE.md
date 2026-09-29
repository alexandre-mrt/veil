# Veil performance baseline

Circuit/proving numbers measured 2026-07-22; on-chain gas measured 2026-09-29. See
[`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md) for the full
methodology, raw command output, and what's still missing. Superseded rows should be replaced in
place with a note in `LEDGER.md` pointing at the experiment that changed them — this file always
reflects the current state of the protocol, not history.

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

## On-chain gas (measured 2026-09-29, local network, RGP 1000, Sui CLI 1.80.1)

Full table, raw output and method: [`2026-09-29-onchain-gas-baseline.md`](2026-09-29-onchain-gas-baseline.md).
MIST; net = computation + storage − rebate. Computation is billed in buckets — every entry point sits
at the 1,000-unit minimum. MIST scales with live RGP/storage price; re-price for testnet/mainnet.

| Entry point | Computation | Net cost | Notes |
|---|---:|---:|---|
| `deposit_and_register` | 1,000,000 | 3,135,068 | one new commitment field |
| `shielded_transfer` | 1,000,000 | 2,875,376 | real proof; net +1 dynamic field |
| `compliant_transfer` | 1,000,000 | 5,288,528 | transfer + compliance proof |
| `zk_withdraw` | 1,000,000 | 4,453,744 | real proof |
| `create_pool` | 1,000,000 | 8,518,680 | |
| `create_compliance_config` | 1,000,000 | 7,321,300 | |
| `propose_withdraw_vk` / `update_commitment_root` | 1,000,000 | 4,317,400 / 1,328,168 | |
| `publish` (one-off) | 1,370,000 | 156,807,480 | |

Below the billing bucket (raw Move-VM gas, `sui move test --statistics`, units): full Groth16 verify
= 267 (transfer) / 248 (withdraw) / 257 (compliance); `prepare_verifying_key` alone = 84 (paid on every
call today). Move suite: 137/137 pass (124 + 13 `gas_bench_*`).

Reproduce: `bun run bench/gas-bench.ts` (from `scripts/`) and `node scripts/bench/gen-move-gas-test.mjs`
+ `sui move test --build-env testnet --statistics` (see the report's Reproduce section).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

