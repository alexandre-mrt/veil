# Veil performance baseline

Measured 2026-07-22 (constraints, proving time) and 2026-09-18 (on-chain gas, Move test suite), on
one machine, in one run each. See [`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md)
and [`2026-09-18-onchain-gas-baseline.md`](2026-09-18-onchain-gas-baseline.md) for full methodology
and raw command output. Superseded rows should be replaced in place with a note in `LEDGER.md`
pointing at the experiment that changed them — this file always reflects the current state of the
protocol, not history.

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

Measured 2026-09-18 on a local Sui network (`sui` 1.72.1-94ad8ccd0ed6 — the CLI release tag matching
`contracts/Move.toml`'s pinned framework `rev`), reference gas price 1000 MIST/unit. "Net" =
`computation + storage − rebate`, what the caller's balance actually drops by. Full methodology,
why local rather than testnet, and the full raw log:
[`2026-09-18-onchain-gas-baseline.md`](2026-09-18-onchain-gas-baseline.md).

| Entry point | Real proof(s) verified | Net cost (MIST) | Net cost (SUI) |
|---|---|---:|---:|
| `publish` (package) | — | 156,807,480 | 0.15681 |
| `create_pool` | — | 8,518,680 | 0.00852 |
| `token_faucet::faucet` | — | 2,364,656 | 0.00236 |
| `deposit_and_register` | — | 1,797,468 | 0.00180 |
| `update_commitment_root` | — | 1,328,168 | 0.00133 |
| `propose_withdraw_vk` | — | 4,317,400 | 0.00432 |
| `create_compliance_config` | — | 7,286,568 | 0.00729 |
| `propose_compliance_toggle` | — | 1,097,432 | 0.00110 |
| `freeze_pool` / `unfreeze_pool` | — | 1,117,268 | 0.00112 |
| `propose_withdrawal` | — | 1,421,268 | 0.00142 |
| **`shielded_transfer`** | 1 (transfer) | 2,872,944 | 0.00287 |
| **`zk_withdraw`** | 1 (withdraw) | 4,451,312 | 0.00445 |
| **`compliant_transfer`** | 2 (transfer + compliance) | 5,007,936 | 0.00501 |

Key finding: **computation cost is the same 1,000,000 MIST minimum bucket for every call above**,
including the three real Groth16/BN254 pairing verifications — on this protocol version, a
`sui::groth16::verify` call is gas-free relative to state writes. Every cost difference between
entry points above is a storage-cost/rebate effect (bytes of new dynamic-field state written), not
a compute effect. See the report for the full argument and its implication for batched-proof
verification (`EXPERIMENTS.md`) and D3's griefing-cost analysis (`docs/threat-model.md`).

Reproduce: `sui start --force-regenesis --with-faucet` (local network, no outbound network access
needed once the CLI binary and circuits are built), then `node scripts/bench/onchain-gas.mjs` — see
that script's header comment for the full prerequisite list, including which `sui` release tag to
use.

## Move contract test suite

**124/124 pass** (`cd contracts && sui move test`), first run 2026-09-18 — previously blocked on the
same missing `sui` CLI as the gas measurements above.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Mobile WASM proving latency | **NOT MEASURED** | The browser harness (`scripts/bench/browser-latency.mjs`) runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope so far; queued. |
| Gas under concurrent load / shared-object contention on `Pool` | **NOT MEASURED** | Tonight's numbers are all single-transaction, uncontended. Real congestion pricing under concurrent `shielded_transfer`s to the same pool is a separate (queued) scalability question. |

Whatever comes out of a future measurement run should replace the corresponding row above in
place, not be appended as a separate table.
