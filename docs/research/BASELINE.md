# Veil performance baseline

Circuit/proving rows measured 2026-07-22, gas rows 2026-10-05, each in one run on one machine. See
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

## On-chain gas per entry point (local Sui network, binary 1.72.4, reference gas price 1000 MIST/unit)

Measured 2026-10-05 with real Groth16 proofs; full table, raw output and caveats in
[`2026-10-05-onchain-gas-baseline.md`](2026-10-05-onchain-gas-baseline.md).
Reproduce: `cd scripts && node bench/gas-bench.ts` (recipe in the file header).

| Entry point | Computation (MIST) | Net cost = comp + storage − rebate (MIST) |
|---|---|---|
| `deposit_and_register` | 1,000,000 | 1,797,468 |
| `shielded_transfer` | 1,000,000 | 2,875,376 – 3,116,144 |
| `compliant_transfer` (2 verifies) | 1,000,000 | 5,288,528 |
| `zk_withdraw` | 1,000,000 | 4,453,744 |
| `create_pool` | 1,000,000 | 8,518,680 |
| `update_commitment_root` / `propose_withdraw_vk` / `create_compliance_config` | 1,000,000 each | 1,328,168 / 4,317,400 / 7,321,300 |
| publish (6 modules) | 1,370,000 | 156,807,480 |

Every transaction landed on the same 1,000,000 MIST computation floor; Groth16 verification is not
the cost driver — storage churn is. Move test suite: 124/124 passing (`sui move test --build-env testnet`).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Gas on real testnet/mainnet | **NOT MEASURED** | Public fullnode RPC is blocked from the research sandbox; numbers above are localnet (same gas schedule, price may differ). |
| True per-verify computation units | **NOT MEASURED** | Gas is bucketed; verify sits under the 1,000-unit floor. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future run should replace the corresponding row above in place, not be
appended as a separate table.
