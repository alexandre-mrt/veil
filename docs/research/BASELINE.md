# Veil performance baseline

Measured 2026-07-22 (circuits, proving) and 2026-10-01 (on-chain gas), each on one machine in one run. See
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

## On-chain gas per entry point (local Sui network, real proofs)

Measured 2026-10-01 by `scripts/bench/gas-localnet.ts` on a `sui 1.81.0` localnet (protocol 138,
reference gas price 1000 MIST/unit). Net = computation + storage − rebate. Full table, batching
curve, raw output and caveats (**local network figures, not mainnet fees**) in
[`2026-10-01-onchain-gas-baseline.md`](2026-10-01-onchain-gas-baseline.md).

| Entry point | Computation (units) | Net (MIST) | Net (SUI) |
|---|---|---|---|
| `deposit_and_register` | 1,000 | 1,799,900 | 0.0018 |
| `shielded_transfer` (steady state) | 1,000 | 3,116,144 | 0.0031 |
| `compliant_transfer` | 1,000 | 5,288,528 | 0.0053 |
| `zk_withdraw` | 1,000 | 4,453,744 | 0.0045 |
| `create_pool` | 1,000 | 8,518,680 | 0.0085 |
| `create_compliance_config` | 1,000 | 7,286,568 | 0.0073 |
| `publish` (6 modules) | 1,390 | 148,024,400 | 0.148 |
| admin timelock proposals / freeze (range) | 1,000 | 0.8M – 4.3M | 0.0008 – 0.0043 |

Computation is at the 1,000-unit protocol floor for every entry point (marginal real work ≈ 342
units per `shielded_transfer`, ≈ 270 per `zk_withdraw`, visible only when batching ≥ 4 in one PTB);
cost is storage-dominated. Move test suite: 124/124 pass (`sui move test --build-env testnet`,
CLI 1.64.0 and 1.81.0). Contracts need a network on Sui ≥ 1.81 (see the report's findings).

Reproduce: see the report's "Reproduce" block (`node --experimental-strip-types bench/gas-localnet.ts`).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Real-network (testnet/mainnet) gas and fee levels | **NOT MEASURED** | Sandbox egress denies the Sui fullnodes; the localnet ratios above should be cross-checked on a real network. |
| Groth16 verification share of the 342 computation units | **NOT MEASURED** | Verifier functions are `public(package)`; needs a test-only wrapper module. |
| Shared-`Pool` contention under concurrent transfers | **NOT MEASURED** | Needs a multi-sender load generator. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Queued. |

Whatever comes out of a future run should replace the corresponding row above in place, not be
appended as a separate table.
