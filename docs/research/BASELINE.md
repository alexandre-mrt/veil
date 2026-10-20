# Veil performance baseline

Measured 2026-07-22 (circuits) and 2026-10-20 (on-chain gas), on one machine per run. See
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

| Circuit | R1CS constraints | Non-linear | Linear | Wires | Public / private inputs | zkey (bytes) | vk JSON (bytes) | Compressed on-chain proof (bytes) |
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

## On-chain gas (local Sui network, sui 1.71.0, reference gas price 1000 MIST)

Measured 2026-10-20 with real Groth16 proofs — report
[`2026-10-20-gas-localnet.md`](2026-10-20-gas-localnet.md), raw data
[`2026-10-20-gas-localnet.json`](2026-10-20-gas-localnet.json). MIST; net = computation + storage − rebate.
Localnet protocol config: storage prices and the computation bucket table may differ on mainnet.

| Entry point | computation | net | net (SUI) |
|---|---:|---:|---:|
| `shielded_transfer` | 1,000,000 | 2,875,984 | 0.0029 |
| `zk_withdraw` | 1,000,000 | 4,454,352 | 0.0045 |
| `compliant_transfer` (transfer + compliance proof) | 1,000,000 | 5,015,460 | 0.0050 |
| `deposit_and_register` | 1,000,000 | 1,797,468 | 0.0018 |
| `create_pool` (488 B VK) | 1,000,000 | 8,518,680 | 0.0085 |
| `create_compliance_config` | 1,000,000 | 7,289,000 | 0.0073 |
| `update_commitment_root` | 1,000,000 | 1,328,168 | 0.0013 |
| `propose_vk_update` / `propose_withdraw_vk` | 1,000,000 | 4,839,140 / 4,317,400 | 0.0048 / 0.0043 |
| `propose_withdrawal` / `execute_pending_withdrawal` | 1,000,000 | 1,423,700 / 2,153,908 | 0.0014 / 0.0022 |
| `freeze_pool` / `unfreeze_pool` | 1,000,000 | 1,122,740 | 0.0011 |
| rejected `shielded_transfer` (bad proof / replay) | 1,000,000 | ≈ 1,105,000–1,107,000 | 0.0011 |
| `publish` (whole package) | 1,370,000 | 156,807,480 | 0.1568 |

Every call, including those running Groth16 verification, reports computation = 1,000,000 MIST
(the minimum bucket); verification is below that floor, so cost is storage-driven. On-chain VK bytes:
488 (transfer), 424 (withdraw), 456 (compliance) — the "vk JSON" column above is the snarkjs file.
Reproduce: `sui start --force-regenesis --with-faucet &`, `sui client switch --env local`,
`sui client faucet`, then `node scripts/bench/gas-localnet.mjs` (needs compiled circuits).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Move contract suite: 124/124 passing under sui 1.71.0 (run 2026-10-20). The gas/Move rows that
used to live here were closed by the 2026-10-20 run and replaced in place above.
