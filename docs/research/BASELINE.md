# Veil performance baseline

Measured 2026-07-22 (circuits, proving) and 2026-10-10 (on-chain gas), on one machine, one run each. See
[`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md) and
[`2026-10-10-onchain-gas-baseline.md`](2026-10-10-onchain-gas-baseline.md) for the full
methodology, raw command output, and caveats. Superseded rows should be replaced in
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

## On-chain gas (local Sui network, real proofs)

Measured 2026-10-10 with `node scripts/bench/gas-localnet.mjs` on `sui 1.81.1-e04cf9aa915c`,
reference gas price **1,000 MIST/unit**, local genesis (**not testnet** — caveats in the report).
Net MIST = computation + storage − storage rebate. Two independent runs: 66/66 transactions
identical. 124/124 Move tests pass.

| Entry point | Computation units | Net MIST | ≈ SUI |
|---|---:|---:|---:|
| `pool::deposit_and_register` | 1,000 | 1,832,200 | 0.0018 |
| `pool::shielded_transfer` (1 proof) | 1,000 | 2,875,376 | 0.0029 |
| `pool::zk_withdraw` (1 proof) | 1,000 | 4,453,744 | 0.0045 |
| `compliance::compliant_transfer` (2 proofs) | 1,000 | 5,290,960 | 0.0053 |
| `pool::create_pool` | 1,000 | 8,518,680 | 0.0085 |
| `compliance::create_compliance_config` | 1,000 | 7,562,068 | 0.0076 |
| `pool::propose_withdraw_vk` / `propose_vk_update` | 1,000 | 4,314,968 / 4,836,100 | 0.0043 / 0.0048 |
| `pool::update_commitment_root` | 1,000 | 1,362,900 | 0.0014 |
| `pool::freeze_pool` / `unfreeze_pool` | 1,000 | 1,119,700 | 0.0011 |
| rejected `shielded_transfer` (bad proof or pre-pairing abort) | 1,000 | 1,106,856 | 0.0011 |
| package publish | 1,370 | 156,807,480 | 0.1568 |

Every single-call entry point, including the 2-proof `compliant_transfer`, is at Sui's 1,000-unit
minimum computation charge: on-chain Groth16 verification is **not** the cost driver; storage is.
Above the floor (PTB with k transfers in one tx: 4 → 1,510, 6 → 2,120, 8 → 2,760 units) each extra
verified transfer adds ≈ 305–320 computation units. Rejected-proof spam costs the attacker the
same ≈ 0.0011 SUI whether it aborts before or after the pairing.

Reproduce: see `scripts/bench/README.md` (start a local network, then
`node scripts/bench/gas-localnet.mjs --out gas.json`; ~5 min, mostly one real 60 s epoch wait).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Gas on **live testnet/mainnet** (as opposed to the local-network numbers above) and shared-object
contention under concurrent senders are not measured; both are in `EXPERIMENTS.md`. Whatever a
future run measures should replace the corresponding row above in place, not be appended as a
separate table.
