# Veil performance baseline

Measured 2026-07-22 (circuits/proving) and 2026-10-08 (gas, Move tests), on one machine, in one run. See
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

## On-chain gas (localnet, MIST, reference gas price 1000)

Measured 2026-10-08 by `scripts/bench/onchain-gas.ts` against `sui start --force-regenesis` with sui
1.72.1 (pinned framework rev) — details and raw output in
[`2026-10-08-onchain-gas.md`](2026-10-08-onchain-gas.md). Localnet gas parameters may differ from testnet.

| Entry point | Computation | Net (comp + storage − rebate) |
|---|---|---|
| `deposit_and_register` | 1,000,000 | 1,797,468 |
| `shielded_transfer` (real Groth16, 7 inputs) | 1,000,000 | 2,872,944 |
| `zk_withdraw` (real Groth16, 5 inputs) | 1,000,000 | 4,451,312 |
| `shielded_transfer`, aborting replay | 1,000,000 | 1,101,992 |
| `freeze_pool` / `unfreeze_pool` | 1,000,000 | 1,117,268 |
| `update_commitment_root` | 1,000,000 | 1,328,168 |
| `propose_withdraw_vk` | 1,000,000 | 4,317,400 |
| `create_pool` | 1,000,000 | 8,518,680 |
| `publish` (one-off) | 1,390,000 | 148,024,400 |

Computation is the minimum bucket for every tx, Groth16 verify included: gas is storage-dominated.
Move suite: `sui move test` → 124/124 pass (sui 1.72.1).
Not yet measured: `compliant_transfer` (two proofs), shared-`Pool` contention, testnet confirmation.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
