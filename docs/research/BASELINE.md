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

## On-chain gas per entry point

Measured 2026-09-15 against a fully local single-validator `sui` network (`sui 1.79.0-46f18562f1f5`,
`sui start --with-faucet`) — public Sui RPC/fullnode hosts are blocked by this environment's egress
policy for every provider tried, so this is not (and cannot currently be) a testnet measurement.
Full methodology, raw output, and the toolchain-unblock story:
[`2026-09-15-onchain-gas-baseline.md`](2026-09-15-onchain-gas-baseline.md).

| Entry point | Computation (MIST) | Storage (MIST) | Rebate (MIST) | Net (MIST) | Net (SUI) |
|---|---:|---:|---:|---:|---:|
| `pool::create_pool` | 1,000,000 | 8,496,800 | 978,120 | 8,518,680 | 0.00852 |
| `pool::deposit_and_register` | 1,000,000 | 10,358,800 | 8,223,732 | 3,135,068 | 0.00314 |
| `pool::shielded_transfer` | 1,000,000 | 14,242,400 | 12,369,456 | 2,872,944 | 0.00287 |
| `pool::zk_withdraw` | 1,000,000 | 15,580,000 | 12,128,688 | 4,451,312 | 0.00445 |
| `compliance::create_compliance_config` | 1,000,000 | 18,171,600 | 11,609,532 | 7,562,068 | 0.00756 |
| `compliance::compliant_transfer` | 1,000,000 | 22,800,000 | 18,749,808 | 5,050,192 | 0.00505 |
| `pool::freeze_pool` / `unfreeze_pool` | 1,000,000 | 11,970,000 | 11,850,300 | 1,119,700 | 0.00112 |
| *(package `publish`, one-time)* | 1,370,000 | 156,415,600 | 978,120 | 156,807,480 | 0.15681 |

**Computation cost is flat at 1,000,000 MIST across every entry point above, proof verification
included** — Groth16 verification gas is bound by public-input count (5–7 for all three circuits),
not by constraint count, so it never leaves Sui's cheapest computation bucket regardless of circuit
size. Gas differences between entry points are entirely a storage story (dynamic-field writes for
nullifiers/commitments, new shared objects). See the linked report for the full breakdown and what
this means for `EXPERIMENTS.md`'s batched-verification item.

Reproduce: `node scripts/bench/gas-baseline.mjs` against a local network (see that file's header
comment for the two `sui genesis`/`sui start` setup commands).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Move contract test suite (124 tests, `sui move test`) | **124/124 PASS** (2026-09-15) | Unblocked alongside the gas measurement — see `2026-09-15-onchain-gas-baseline.md`. |
| Gas under concurrent load / shared-object contention | **NOT MEASURED** | 2026-09-15's numbers are from a single-validator network processing one transaction at a time — no contention on the shared `Pool` object. Queued. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope so far; queued. |

Whatever comes out of a future gas/contention run should replace the corresponding row above in
place, not be appended as a separate table.
