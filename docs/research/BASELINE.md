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

## On-chain gas per entry point (measured 2026-11-19)

Real transactions with real Groth16 proofs on a local Sui network: `sui 1.72.1-94ad8ccd0ed6`, built
at the framework rev pinned in `contracts/Move.toml`, protocol version 124, RGP 1000 MIST. MIST
values are exact `effects.gasUsed`; "net" = computation + storage − rebate (what the sender pays).
Testnet/mainnet scale with their RGP and storage price. Source:
[`2026-11-19-onchain-gas.md`](2026-11-19-onchain-gas.md).

| Entry point | Computation (units) | Storage charged | Rebate | **Net (MIST)** |
|---|---|---|---|---|
| `publish` (whole package) | 1,390 | 156,415,600 | 9,781,200 | **148,024,400** |
| `pool::create_pool` | 1,000 | 8,496,800 | 978,120 | **8,518,680** |
| `pool::deposit_and_register` | 1,000 | 13,588,800 | 11,421,432 | **3,167,368** |
| `pool::shielded_transfer` (steady state) | 1,000 | 14,485,600 | 12,369,456 | **3,116,144** |
| `pool::zk_withdraw` | 1,000 | 15,823,200 | 12,369,456 | **4,453,744** |
| `compliance::compliant_transfer` (2 Groth16 verifies) | 1,000 | 22,556,800 | 18,268,272 | **5,288,528** |
| `compliance::create_compliance_config` | 1,000 | 17,928,400 | 11,609,532 | **7,318,868** |
| `pool::propose_withdraw_vk` | 1,000 | 11,726,800 | 8,411,832 | **4,314,968** |
| `pool::propose_vk_update` | 1,000 | 15,686,400 | 11,850,300 | **4,836,100** |
| `pool::update_commitment_root` | 1,000 | 12,213,200 | 11,850,300 | **1,362,900** |
| `pool::freeze_pool` / `unfreeze_pool` | 1,000 | 11,970,000 | 11,850,300 | **1,119,700** |

Every non-publish transaction sits at the 1,000-unit computation floor — Groth16 verification is not
what Veil pays for on Sui; storage churn on the shared `Pool` object is. Reproduce:
`sui start --with-faucet --force-regenesis &` then
`node scripts/bench/gas-localnet.mjs --contracts contracts --label baseline`.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Move contract suite: `sui move test --build-env testnet` → 124/124 passing (2026-11-19, same
`sui` build). Note: the 2026-11-19 circuit setup used a locally generated pot15 ptau (Hermez
download blocked); constraint counts are ptau-independent and the proving-time rows above are from
2026-07-22.
