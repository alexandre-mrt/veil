# Veil performance baseline

Measured 2026-07-22 (constraints, artifact sizes, proving time) and 2026-09-02 (on-chain gas, Move
test suite), on one machine, in one run each. See
[`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md) and
[`2026-09-02-onchain-gas.md`](2026-09-02-onchain-gas.md) for full methodology and raw command
output. Superseded rows should be replaced in place with a note in `LEDGER.md` pointing at the
experiment that changed them — this file always reflects the current state of the protocol, not
history.

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

## On-chain gas per entry point (2026-09-02, real local-network transactions)

Toolchain: `sui` 1.79.0-46f18562f1f5, built from source (`cargo install --locked --git
https://github.com/MystenLabs/sui.git --branch testnet sui`, rustc 1.96.1 — the branch's own pinned
version; the system default 1.94.1 hit a real compile error in `consensus-core`). Measured against
a local Sui validator (`sui start --with-faucet --force-regenesis`), not testnet — see
[`2026-09-02-onchain-gas.md`](2026-09-02-onchain-gas.md) for why a local network is a legitimate
stand-in (same binary, same protocol version, same gas-pricing formulas) and why testnet itself
remains unreachable from this sandbox. Reference gas price: 1000 MIST/unit. "Net" =
`computationCost + storageCost − storageRebate`.

| Entry point | Net gas (MIST) | Net gas (SUI) |
|---|---:|---:|
| `pool::create_pool` | 8,518,680 | 0.008519 |
| `compliance::create_compliance_config` | 7,529,768 | 0.007530 |
| `pool::propose_withdraw_vk` | 4,317,400 | 0.004317 |
| `pool::propose_vk_update` | 4,836,100 | 0.004836 |
| `pool::cancel_vk_update` | −2,559,536 | −0.002560 |
| `pool::freeze_pool` / `pool::unfreeze_pool` | 1,119,700 each | 0.001120 |
| `pool::propose_withdrawal` | 1,423,700 | 0.001424 |
| `pool::cancel_withdrawal` | 818,740 | 0.000819 |
| `token_faucet::faucet` | 2,364,656 | 0.002365 |
| `pool::deposit_and_register` | 1,832,200 | 0.001832 |
| `pool::update_commitment_root` | 1,362,900 | 0.001363 |
| `pool::shielded_transfer` | 2,875,376 | 0.002875 |
| `pool::zk_withdraw` | 4,453,744 | 0.004454 |
| `compliance::compliant_transfer` (2 Groth16 verifications) | 5,050,192 | 0.005050 |

Reproduce: `sui start --with-faucet --force-regenesis &`, `sui client switch --env local`, then
`node scripts/bench/onchain-gas.mjs` (requires circuits compiled: `bash
circuits/scripts/compile{,-withdraw,-compliance}.sh`).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Mobile WASM proving latency | **NOT MEASURED** | The browser harness (`scripts/bench/browser-latency.mjs`) runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). Queue item #7. |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope so far; queued (item #10). |
| Batched/aggregated proof verification savings | **NOT MEASURED** | Now unblocked by the per-entry-point gas numbers above; queue item #2. |
| Merkle accumulator at 10^5–10^7 commitments | **NOT MEASURED** | Queue item #3; `update_commitment_root`'s single-call cost above is its starting baseline. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
