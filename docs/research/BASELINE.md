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

Measured 2026-10-11 on a local Sui network (`sui 1.72.1-94ad8ccd0ed6`, built from the revision
`contracts/Move.toml` pins), reference gas price 1000 MIST, real Groth16 proofs. MIST; 1 SUI = 10⁹.
`net = computation + storage − rebate`. Full method and raw output:
[`2026-10-11-onchain-gas-baseline.md`](2026-10-11-onchain-gas-baseline.md). **Localnet, not
mainnet** — the shape (what dominates) is the result; absolutes move with the epoch's gas price.

| Entry point | Computation | Storage | Rebate | Net |
|---|---:|---:|---:|---:|
| `publish` | 1,380,000 | 156,415,600 | 4,890,600 | 152,905,000 |
| `create_pool` | 1,000,000 | 8,496,800 | 978,120 | 8,518,680 |
| `deposit_and_register` | 1,000,000 | 10,358,800 | 8,223,732 | 3,135,068 |
| `update_commitment_root` (propose) | 1,000,000 | 8,740,000 | 8,411,832 | 1,328,168 |
| `propose_withdraw_vk` | 1,000,000 | 11,970,000 | 8,652,600 | 4,317,400 |
| `shielded_transfer` | 1,000,000 | 14,242,400 | 12,369,456 | 2,872,944 |
| `zk_withdraw` | 1,000,000 | 15,580,000 | 12,128,688 | 4,451,312 |

Verifier marginal computation (N calls per PTB, slope): `prepare_verifying_key` ≈ 84,600 MIST,
`verify_full` transfer (7 inputs) ≈ 270,000, withdraw (5 inputs) ≈ 248,000. Computation is billed
in buckets with a 1,000,000 MIST floor, so every single-call entry point pays exactly the floor.
Verification is 9.4 % of a `shielded_transfer`; storage is 65 %.

Reproduce: `sui start --force-regenesis --with-faucet`, then `cd scripts && bun run bench/gas-local.ts`.

## Test suites (2026-10-11)

Move 124/124 (`cd contracts && sui move test`); circuits 43 + 30 + 35; converter, compliance utils,
fuzz (6 properties), frontend vitest 19 — all green on this commit.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Gas: `compliant_transfer`, `create_compliance_config`, other admin/timelock ops, `emergency_withdraw` | **NOT MEASURED** | Not driven in the 2026-10-11 run (compliance wiring left to a follow-up). `compliant_transfer` verifies two proofs and is the one entry point that could exceed the computation floor. |
| Gas at mainnet gas price | **NOT MEASURED** | Testnet fullnode is policy-denied from the research sandbox; localnet RGP is 1000. |
| Proving time re-run | **NOT RE-RUN 2026-10-11** | pot15 was regenerated locally (Hermez ptau is no longer downloadable), so the proving-time table above is from 2026-07-22 and was not re-measured. Constraint counts re-confirmed (transfer 6,470 + 7,141). |
| Mobile WASM proving latency | **NOT MEASURED** | Extend `scripts/bench/browser-latency.mjs` with a mobile device-emulation profile. |
| Relayer throughput / leakage under load | **NOT MEASURED** | Queued. |

Whatever a future run produces should replace the corresponding row above in place, not be appended
as a separate table.
