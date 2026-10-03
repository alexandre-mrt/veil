# Veil performance baseline

Measured 2026-07-22 (circuits, proving) and 2026-10-03 (on-chain gas, Move tests), on one machine per run. See
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

## On-chain gas per entry point (local network, Sui 1.82, reference gas price 1000 MIST/unit)

Measured 2026-10-03 — [`2026-10-03-onchain-gas-baseline.md`](2026-10-03-onchain-gas-baseline.md).
Every entry point is charged the **1,000-unit computation floor (1,000,000 MIST)**; "raw" units are
recovered by dry-run subtraction (±10 units). Reproduce: `node scripts/bench/gas-localnet.mjs` (see
script header for the local-network prerequisites).

| Entry point | Raw computation units | Net cost (MIST) |
|---|---|---|
| `deposit_and_register` | 170 | 3,052,831 |
| `shielded_transfer` | 340 | 2,749,274 – 2,992,449 |
| `compliant_transfer` (2 proofs) | 650 | 5,105,845 |
| `zk_withdraw` | 460 | 4,330,049 |
| `update_commitment_root` / `propose_withdraw_vk` | 20 / 20 | 1,244,050 / 4,230,874 |
| `create_pool` / `create_compliance_config` | <10 / 30 | 8,508,899 / 7,202,797 |
| package publish (contracts + bench module) | n/a | 163,472,099 |

Verifier: `prepare_verifying_key` 85 raw units; verify (VK prepared each call) 270; verify (VK
prepared once) 185. Up to 2 verifications per PTB (3 with a prepared VK) stay inside the floor.
Net storage (~1.75M MIST per transfer) outweighs computation (1.0M MIST floor).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Move contract suite: **124/124 pass** (2026-10-03, `sui-move test -e testnet`, Sui 1.82 built from source).
Gas numbers above are from a local network, not testnet/mainnet protocol parameters.
