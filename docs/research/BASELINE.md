# Veil performance baseline

Circuit/proving numbers measured 2026-07-22; on-chain gas measured 2026-10-04 (see below). One machine per run. See
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

## On-chain gas per entry point (2026-10-04, localnet, `sui 1.72.1`, RGP 1000)

Report: [`2026-10-04-onchain-gas-baseline.md`](2026-10-04-onchain-gas-baseline.md). Reproduce:
`cd scripts/bench && npm install && sui start --force-regenesis --with-faucet & node --experimental-strip-types --no-warnings gas.ts --samples 3 --epoch-ms 120000`.
Computation in gas units (1,000 = the per-tx minimum); net = computation + storage − rebate, MIST. Prices
(RGP, storage price) differ on testnet/mainnet; units and bytes do not.

| Entry point | Computation (units) | Net (MIST) |
|---|---|---|
| `deposit_and_register` | 1,000 (floor) | 1,797,468 |
| `shielded_transfer` | 1,000 (floor) | 3,035,888 |
| `compliant_transfer` | 1,000 (floor) | 5,288,528 |
| `zk_withdraw` | 1,000 (floor) | 4,453,744 |
| 4 × `shielded_transfer` in one PTB | 1,510 | 9,661,304 (2.42 M each) |
| `create_pool` / `create_compliance_config` | 1,000 | 8,518,680 / 7,321,300 |
| admin proposals / freeze (`propose_*`, `freeze_pool`, …) | 1,000 | 0.8 – 4.3 M |
| publish package | 1,390 | 148,024,400 |

Groth16 verify on-chain: ≈267 compute units (≈83 `prepare_verifying_key` + ≈185 verify). Below the
1,000-unit floor, so aggregation saves nothing until ≥4 proofs share a tx.

## Move contract tests

`sui move test` (CLI 1.72.1): `Test result: OK. Total tests: 124; passed: 124; failed: 0` (2026-10-04).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Gas in SUI on testnet/mainnet | **NOT MEASURED** | Localnet prices only; testnet fullnode unreachable from the sandbox (egress allowlist). |
| Shared-object contention (k concurrent PTBs on one Pool) | **NOT MEASURED** | Single-client run. |
| Mobile WASM proving latency | **NOT MEASURED** | Desktop headless Chromium only; extend `browser-latency.mjs` with `page.emulate`. |
| Relayer throughput / leakage under load | **NOT MEASURED** | Queued. |

Note: the 2026-10-04 zkeys used a locally generated pot15 (Hermez ptau hosts returned 403), so
zkey byte sizes there are not comparable with the table above; constraint counts are identical.
