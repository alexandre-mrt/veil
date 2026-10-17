# Veil performance baseline

Measured 2026-07-22 (circuits, proving) and 2026-10-17 (gas), each in one run on one machine. See
[`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md) for the full
methodology, raw command output, and what's still missing. Superseded rows should be replaced in
place with a note in `LEDGER.md` pointing at the experiment that changed them — this file always
reflects the current state of the protocol, not history.

Toolchain: circom 2.2.2 (built from source, `iden3/circom` tag `v2.2.2`), snarkjs 0.7.6, Node
v22.22.2, Chromium 141 (headless, via Playwright), sui 1.72.1 (local network, release binary `testnet-v1.72.1`, matches the pinned framework rev), pot15 Powers of Tau (Hermez, `2^15` — reused
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

## On-chain gas per entry point (2026-10-17, local network, RGP 1000 MIST/unit, no tip)

Full methodology and raw output: [`2026-10-17-gas-per-entry-point.md`](2026-10-17-gas-per-entry-point.md).
Reproduce: `node scripts/bench/gas.mjs` against `sui start --force-regenesis --with-faucet`.

| Entry point | Computation (units) | Net cost (MIST) = comp + storage − rebate |
|---|---|---|
| `publish` (6 modules) | 1,380 | 152,905,000 |
| `pool::create_pool` | 1,000 | 8,518,680 |
| `pool::deposit_and_register` | 1,000 | 3,135,068 |
| `pool::shielded_transfer` (1 verify) | 1,000 | 2,875,376 |
| `compliance::compliant_transfer` (2 verifies) | 1,000 | 5,288,528 |
| `pool::zk_withdraw` (1 verify) | 1,000 | 4,453,744 |
| `compliance::create_compliance_config` | 1,000 | 7,321,300 |
| `pool::update_commitment_root` / `propose_withdraw_vk` / `freeze_pool` | 1,000 | 1,328,168 / 4,317,400 / 1,119,700 |
| `shielded_transfer`, rejected proof | 1,000 | 1,106,856 |

Every entry point sits on Sui's 1,000-unit minimum computation bucket; the bill is mostly storage.
Groth16 marginal cost (framework only): ≈188 units/verify (7 inputs), ≈167 (5 inputs), ≈10.7
units/public input, ≈86 units/`prepare_verifying_key`. Move test suite: 124/124 pass.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Any future gas run should replace the gas table above in place, not be appended as a separate table.
