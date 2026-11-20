# Veil performance baseline

Measured 2026-07-22, on one machine, in one run. See
[`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md) for the full
methodology, raw command output, and what's still missing. Superseded rows should be replaced in
place with a note in `LEDGER.md` pointing at the experiment that changed them — this file always
reflects the current state of the protocol, not history.

Toolchain: circom 2.2.2 (built from source, `iden3/circom` tag `v2.2.2`), snarkjs 0.7.6, Node
v22.22.2, Chromium 141 (headless, via Playwright), pot15 Powers of Tau (Hermez, `2^15` — reused
for all three circuits per the existing `compile*.sh` scripts), single dev-only Groth16
contribution (matches `circuits/scripts/compile*.sh` — **not** a production ceremony; see
`ceremony.sh` and `docs/threat-model.md` RR2). From 2026-11-20 the Hermez ptau download is refused
by this environment, so nightly runs generate a local 2^15 ptau with snarkjs (also dev-only).
Constraint counts are unchanged, and VK/proof sizes don't depend on the ptau.

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

Measured 2026-11-20 by executing real transactions with real Groth16 proofs on a local Sui network:
`sui 1.72.1-94ad8ccd0ed6` (the framework rev pinned in `contracts/Move.toml`), protocol v124,
reference gas price 1,000 MIST/unit. See
[`2026-11-20-onchain-gas-baseline.md`](2026-11-20-onchain-gas-baseline.md). Deterministic:
two full runs gave identical tables. Net = computation + storage − rebate (what the sender pays).

| Entry point | Computation units | Storage cost (MIST) | Rebate (MIST) | **Net (MIST)** |
|---|---|---|---|---|
| `shielded_transfer` | 1,000 (floor) | 14,485,600 | 12,369,456 – 12,610,224 | **2,875,376 – 3,116,144** |
| `compliance::compliant_transfer` | 1,000 (floor) | 22,556,800 | 18,268,272 | **5,288,528** |
| `zk_withdraw` | 1,000 (floor) | 15,823,200 | 12,369,456 | **4,453,744** |
| `deposit_and_register` (incl. coin split) | 1,000 | 10,358,800 | 8,223,732 | 3,135,068 |
| `create_pool` | 1,000 | 8,496,800 | 978,120 | 8,518,680 |
| `compliance::create_compliance_config` | 1,000 | 18,171,600 | 11,850,300 | 7,321,300 |
| `update_commitment_root` | 1,000 | 8,740,000 | 8,411,832 | 1,328,168 |
| `propose_withdraw_vk` | 1,000 | 11,970,000 | 8,652,600 | 4,317,400 |
| `propose_vk_update` | 1,000 | 15,929,600 | 12,091,068 | 4,838,532 |
| `cancel_vk_update` | 1,000 | 12,213,200 | 15,770,304 | −2,557,104 |
| package `publish` | 1,390 | 156,415,600 | 9,781,200 | 148,024,400 |

Groth16 cost per call (slope of an n = 64 → 128 in-transaction sweep,
`scripts/bench/groth16-gas`): `prepare_verifying_key` ≈ 86 units, verify with a prepared key
≈ 183 units, prepare + verify (Veil today) ≈ 267 units. That is well under the 1,000-unit
per-transaction floor, so verification is currently invisible in what users pay. Storage
dominates.

Reproduce: `sui start --with-faucet --force-regenesis`, then `cd scripts && node bench/gas.ts --runs 3`
(prerequisites in the script header).

## Test suites

| Suite | Result (2026-11-20) |
|---|---|
| `contracts`: `sui move test` | 124 / 124 passed |
| `circuits`: `npm test` | 43 + 30 + 35 passed |
| `scripts`: converter / compliance-utils / fuzz | all passed |
| `frontend`: tsc, biome, vitest | clean, 19 / 19 passed |

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Gas on testnet/mainnet protocol versions | **NOT MEASURED** | Public fullnode RPC is refused by this environment's egress proxy; the numbers above are pinned to localnet protocol v124. |
| Shared-object contention on `Pool` under concurrent senders | **NOT MEASURED** | `gas.ts` is single-sender; queued. |
| Mobile WASM proving latency | **NOT MEASURED** | Extend `browser-latency.mjs` with a device-emulation profile; queued. |
| Relayer throughput / leakage under load | **NOT MEASURED** | Queued. |
