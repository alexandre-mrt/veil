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

## On-chain gas per entry point (MIST, one tx each, real Groth16 proofs)

Measured 2026-11-23 on a local network (`sui 1.84.1-e83d69069e40` built from source, protocol 142,
gas model v15, reference gas price 1000). Source: [`2026-11-23-onchain-gas-baseline.md`](2026-11-23-onchain-gas-baseline.md).
`net = computation + storage − rebate`.

| Entry point | Computation | Storage | Rebate | Net |
|---|---:|---:|---:|---:|
| publish (whole package) | 1,380,000 | 156,415,600 | 4,939,506 | 152,856,094 |
| `create_pool` | 1,000,000 | 8,496,800 | 987,901 | 8,508,899 |
| `propose_withdraw_vk` | 1,000,000 | 11,726,800 | 8,495,950 | 4,230,850 |
| `create_compliance_config` | 1,000,000 | 18,171,600 | 11,968,803 | 7,202,797 |
| `update_commitment_root` | 1,000,000 | 11,970,000 | 11,725,627 | 1,244,373 |
| `propose_compliance_toggle` | 1,000,000 | 11,977,600 | 11,968,803 | 1,008,797 |
| `freeze_pool` / `unfreeze_pool` | 1,000,000 | 11,970,000 | 11,968,803 | 1,001,197 |
| `deposit_and_register` (100 TOKEN, incl. split) | 1,000,000 | 13,588,800 | 11,535,646 | 3,053,154 |
| `shielded_transfer` | 1,000,000 | 14,485,600 | 12,736,326 | 2,749,274 |
| `zk_withdraw` | 1,000,000 | 15,823,200 | 12,493,151 | 4,330,049 |
| `compliant_transfer` | 1,000,000 | 22,556,800 | 18,458,554 | 5,098,246 |

Every entry point's computation sits at the 1,000-unit floor. Storage, mostly the full rewrite of
the shared `Pool` (≈12M MIST gross, 99% rebated) plus new dynamic fields, is the real cost.
Groth16 verification, by looped slope: 267.5 / 247.0 / 257.0 units (transfer / withdraw /
compliance VK), of which `prepare_verifying_key` is about 83 units. Sui-encoded VK sizes: 488 /
424 / 456 bytes. Reproduce: `bash scripts/bench/run-gas-local.sh` (needs `sui` on PATH).

## Test suites

| Suite | Result (2026-11-23) |
|---|---|
| Move (`cd contracts && sui move test`) | 124 pass |
| Circuits (`cd circuits && npm test`, real Groth16) | 43 + 30 + 35 pass |

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas on testnet's live protocol version | **NOT MEASURED** | Local-network numbers above are protocol 142 / gas model v15. Testnet fullnode returns 403 from the sandbox (2026-11-23). Older gas models bucket computation more coarsely. |
| Shared-object contention under concurrent transfers | **NOT MEASURED** | All gas rows above are serial, one tx at a time. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Future gas runs should replace the gas table above in place, not append a separate table.
