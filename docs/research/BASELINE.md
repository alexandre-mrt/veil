# Veil performance baseline

Measured 2026-07-22 (circuits) and 2026-10-24 (on-chain gas), on one machine per run. See
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

## On-chain gas per entry point (Sui localnet 1.72.2, gas price 1000, MIST)

Measured 2026-10-24 by `node --experimental-strip-types --no-warnings scripts/bench/gas-localnet.ts`
(from `scripts/`) with real proofs. Report: [`2026-10-24-onchain-gas-baseline.md`](2026-10-24-onchain-gas-baseline.md).

| Entry point | Computation | Net (comp + storage − rebate) |
|---|---|---|
| `create_pool` | 1,000,000 | 8,518,680 |
| `deposit_and_register` (flat in pool size) | 1,000,000 | 3,135,068 |
| `shielded_transfer` | 1,000,000 | 2,875,376 |
| `compliant_transfer` (2 proofs) | 1,000,000 | 5,288,528 |
| `zk_withdraw` | 1,000,000 | 4,453,744 |
| `update_commitment_root` / `propose_withdraw_vk` / `create_compliance_config` | 1,000,000 | 1,328,168 / 4,317,400 / 7,321,300 |
| publish (whole package) | 1,370,000 | 156,807,480 |

Every Veil call is billed the **minimum computation bucket (1,000 units)**; variation is storage.
Groth16 verifier cost (`scripts/bench/gas-probe.ts`), computation units per call: prepare VK 83.6;
verify (prepared) 184.0 transfer / 164.5 withdraw / 174.2 compliance; prepare+verify (current
`veil::verifier`) 267.2 / 248.0 / 257.4. ≤3 verifications per tx stay inside the floor bucket.

Move test suite: 124/124 pass (`sui move test --build-env testnet`, sui 1.72.2).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Testnet/mainnet gas (vs localnet) | **NOT MEASURED** | Sandbox blocks fullnode hosts; localnet storage price is a protocol constant, computation depends on live gas price. |
| Shared-object contention under concurrent transfers | **NOT MEASURED** | Queued. |
| Mobile WASM proving latency | **NOT MEASURED** | Extend `scripts/bench/browser-latency.mjs` with a mobile device profile. |
| Relayer throughput / leakage under load | **NOT MEASURED** | Queued. |
