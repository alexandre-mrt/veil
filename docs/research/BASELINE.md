# Veil performance baseline

Measured 2026-07-22 (circuits/proving) and 2026-08-02 (on-chain gas), on one machine. See
[`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md) and
[`2026-08-02-onchain-gas-baseline.md`](2026-08-02-onchain-gas-baseline.md) for full methodology, raw
command output, and what's still missing. Superseded rows should be replaced in place with a note in
`LEDGER.md` pointing at the experiment that changed them — this file always reflects the current
state of the protocol, not history.

Toolchain: circom 2.2.2 (built from source, `iden3/circom` tag `v2.2.2`), snarkjs 0.7.6, Node
v22.22.2, Chromium 141 (headless, via Playwright), pot15 Powers of Tau (Hermez, `2^15` — reused
for all three circuits per the existing `compile*.sh` scripts), single dev-only Groth16
contribution (matches `circuits/scripts/compile*.sh` — **not** a production ceremony; see
`ceremony.sh` and `docs/threat-model.md` RR2). `sui` CLI: `mainnet-v1.76.1` — the working release for
this repo's pinned (bleeding-edge) framework revision; see the 2026-08-02 report for why two other
releases failed to build it.

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

Measured 2026-08-02 against a fresh local Sui network (`sui start --force-regenesis --with-faucet`,
`sui` CLI `1.76.1-433212f8f276`) — real Move VM, real `sui::groth16` native verification, real
storage pricing, but not real testnet/mainnet congestion (public Sui RPC endpoints remain
network-policy-denied in this session; see the report for detail). Net = computation + storage −
rebate, the amount actually charged. Full methodology, raw output, and reproduce steps:
[`2026-08-02-onchain-gas-baseline.md`](2026-08-02-onchain-gas-baseline.md).

| Entry point | Net gas (MIST) | Net gas (SUI) |
|---|---:|---:|
| `publish` (whole package) | 156,807,480 | 0.15680748 |
| `pool::create_pool` | 8,518,680 | 0.00851868 |
| `pool::deposit_and_register` | 3,167,368 | 0.00316737 |
| `pool::shielded_transfer` | −806,292 | −0.00080629 |
| `pool::zk_withdraw` | 4,451,312 | 0.00445131 |
| `compliance::compliant_transfer` (dual proof) | 5,015,460 | 0.00501546 |
| `compliance::create_compliance_config` | 7,286,568 | 0.00728657 |
| `pool::propose_withdraw_vk` | 4,314,968 | 0.00431497 |
| `pool::update_commitment_root` | 1,360,468 | 0.00136047 |
| `pool::propose_vk_update` | 4,836,100 | 0.00483610 |
| `pool::propose_withdrawal` | 1,388,968 | 0.00138897 |
| `pool::execute_pending_withdrawal` | 2,121,608 | 0.00212161 |
| `pool::freeze_pool` | 1,088,008 | 0.00108801 |
| `pool::unfreeze_pool` | 1,088,008 | 0.00108801 |
| `pool::emergency_withdraw` | 2,422,568 | 0.00242257 |

`shielded_transfer`'s negative net gas is real, not a rounding artifact: it deletes one dynamic field
(the spent UTXO commitment) while adding two, and the deletion's storage rebate outweighs the
addition's cost. Computation cost is flat at 1,000,000 MIST for every call except `publish`
regardless of how many Groth16 proofs it verifies — on Sui's bucketed gas model, verification cost
shows up in storage cost (calldata + state diff), not computation cost. See the report for detail.

Reproduce: `sui move test -e testnet` (Move suite, 124 tests) and
`node --experimental-vm-modules scripts/bench/gas-onchain.mjs` (gas benchmark; needs a local network
running — see the script's header comment for exact setup commands).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas on real testnet/mainnet (congestion-adjusted reference gas price) | **NOT MEASURED** | Public Sui RPC hosts (`fullnode.testnet.sui.io`, `fullnode.mainnet.sui.io`) remain network-policy-denied in this session (`403` at the CONNECT layer). The local-network numbers above are real Move-VM gas, not real network gas. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future testnet-gas or relayer-load run should replace the corresponding row
above in place, not be appended as a separate table.
