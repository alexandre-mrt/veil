# Veil performance baseline

Circuit/proving numbers measured 2026-07-22; on-chain gas and test suites measured 2026-11-13. See
[`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md) for the full
methodology, raw command output, and what's still missing. Superseded rows should be replaced in
place with a note in `LEDGER.md` pointing at the experiment that changed them — this file always
reflects the current state of the protocol, not history.

Toolchain: circom 2.2.2 (built from source, `iden3/circom` tag `v2.2.2`), snarkjs 0.7.6, Node
v22.22.2, Chromium 141 (headless, via Playwright), pot15 Powers of Tau (Hermez, `2^15` — reused
for all three circuits per the existing `compile*.sh` scripts), single dev-only Groth16
contribution (matches `circuits/scripts/compile*.sh` — **not** a production ceremony; see
`ceremony.sh` and `docs/threat-model.md` RR2).

**Note (2026-11-13):** the Hermez pot15 URL used by `compile*.sh` and CI now returns 403 (both
known mirrors). The 2026-11-13 gas run used a locally generated dev pot15 instead; gas and
constraint counts are SRS-independent, and proving time/zkey size were not re-measured.

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

Measured 2026-11-13 on a Sui localnet (`sui 1.72.1-94ad8ccd0ed6`, the exact framework rev pinned in
`contracts/Move.toml`), RGP = 1,000 MIST, with real Groth16 proofs. Two fresh deployments gave
bit-identical numbers. Full writeup: [`2026-11-13-onchain-gas-per-entry.md`](2026-11-13-onchain-gas-per-entry.md).
MIST totals scale with the network's RGP and storage price; units and storage bytes carry over.

| Entry point | Computation (gas units) | Storage charged (MIST) | Rebate (MIST) | **Net paid (MIST)** |
|---|---|---|---|---|
| `publish` | 1,370 | 156,415,600 | 978,120 | **156,807,480** |
| `pool::create_pool` | 1,000 | 8,496,800 | 978,120 | **8,518,680** |
| `pool::deposit_and_register` | 1,000 | 9,021,200 | 8,223,732 | **1,797,468** |
| `pool::update_commitment_root` | 1,000 | 8,740,000 | 8,411,832 | **1,328,168** |
| `pool::propose_withdraw_vk` | 1,000 | 11,970,000 | 8,652,600 | **4,317,400** |
| `compliance::create_compliance_config` | 1,000 | 18,171,600 | 11,850,300 | **7,321,300** |
| `pool::shielded_transfer` (steady state) | 1,000 | 14,485,600 | 12,369,456 | **3,116,144** |
| `compliance::compliant_transfer` | 1,000 | 22,556,800 | 18,268,272 | **5,288,528** |
| `pool::zk_withdraw` | 1,000 | 15,823,200 | 12,369,456 | **4,453,744** |

Every proof-bearing call sits in Sui's minimum computation bucket (1,000 units), so Groth16
verification costs at most 1,000 units and is ~32% of a transfer's net cost. Storage is the rest:
nullifier/commitment dynamic fields, plus a full rewrite of the Pool object (and, for compliant
transfers, the ComplianceConfig) on every transaction.

Reproduce (needs a running localnet; see the script header):
`node --experimental-strip-types --no-warnings scripts/bench/gas-per-entry.mjs --runs 3`

## Test suites

| Suite | Result (2026-11-13) |
|---|---|
| `sui move test` (contracts) | 124 / 124 passed |
| `circuits` `npm test` (real Groth16) | 43 + 30 + 35 passed |
| `scripts` converter / compliance-utils / fuzz | 109 + 67 passed, 6/6 properties |
| `frontend` tsc / biome / vitest | clean / clean / 19 passed |

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |
| Concurrent-transfer throughput on the shared Pool object | **NOT MEASURED** | 2026-11-13 gas runs were sequential; every transfer/withdraw/deposit takes `&mut Pool`. Queued. |

Whatever comes out of a future run should replace the corresponding row above in place, not be
appended as a separate table.
