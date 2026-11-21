# Veil performance baseline

Circuit and proving numbers measured 2026-07-22; on-chain gas and the Move suite measured 2026-11-21
(constraint counts re-confirmed identical after a fresh compile that night). See
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

## On-chain gas (measured 2026-11-21)

sui 1.84.1 localnet (`sui start --with-faucet --force-regenesis`), RGP 1000 MIST, real Groth16
proofs. Computation is given in **units** (MIST ÷ RGP), which carry over to other networks. MIST
totals scale with each network's RGP and storage price. Full raw output:
[`2026-11-21-onchain-gas-baseline.md`](2026-11-21-onchain-gas-baseline.md).

| Entry point | Computation (units) | Storage (MIST) | Rebate (MIST) | Net (MIST @ RGP 1000) |
|---|---|---|---|---|
| `pool::deposit_and_register` | 1,000 (floor) | 13,588,800 | 11,535,646 | 3,053,154 |
| `pool::shielded_transfer` | 1,000 (floor) | 14,485,600 | 12,736,326 | 2,749,274 |
| `compliance::compliant_transfer` | 1,000 (floor) | 22,556,800 | 18,450,955 | 5,105,845 |
| `pool::zk_withdraw` | 1,000 (floor) | 15,823,200 | 12,493,151 | 4,330,049 |
| `pool::create_pool` | 1,000 | 8,496,800 | 987,901 | 8,508,899 |
| `compliance::create_compliance_config` | 1,000 | 18,171,600 | 11,968,803 | 7,202,797 |
| `pool::update_commitment_root` | 1,000 | 11,970,000 | 11,725,627 | 1,244,373 |
| `pool::freeze_pool` (typical 1-field admin op) | 1,000 | 12,213,200 | 12,211,979 | 1,001,221 |
| publish (6 modules) | 1,380 | 156,415,600 | 4,939,506 | 152,856,094 |

Per-call `sui::groth16` cost (computation units, slope inside one tx):

| Circuit (public inputs) | prepare + verify | verify only | prepare only |
|---|---|---|---|
| transfer (7) | 268.5 | 183.0 | 82.5 |
| compliance (6) | 258.5 | 173.5 | 83.0 |
| withdraw (5) | 247.0 | 164.0 | 83.0 |

Every single-proof (or two-proof) call sits on the 1,000-unit per-tx computation floor. Storage
is 60–80% of each user call's net cost.

Reproduce: `NO_PROXY=127.0.0.1,localhost node scripts/bench/gas-localnet.mjs` and
`node scripts/bench/gas-verify-probe.mjs` against a fresh localnet (see the script headers).

## Test suite

| Layer | Result (2026-11-21) |
|---|---|
| Move (`sui move test`) | 124 / 124 pass |
| Circuits, full-proof mode (`npm test`) | 43 + 30 + 35 pass |
| Scripts (converter / compliance utils / fuzz) | 109 / 67 / 6 properties pass |
| Frontend (tsc, biome, vitest) | clean, clean, 19 pass |

**The green suite does not imply the protocol is sound.** On 2026-11-21 two critical exploits
(deposit-amount inflation F1, withdrawal front-running F2) succeeded on-chain against this same
commit. See the report and `docs/threat-model.md` E4/E7.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Gas on testnet/mainnet (real RGP) | **NOT MEASURED** | Public fullnodes are unreachable from the research sandbox (403). Localnet units carry over; MIST does not. |
| Shared-`Pool` contention under concurrent transfers | **NOT MEASURED** | Queued. All measurements above are sequential on an idle localnet. |
| Mobile WASM proving latency | **NOT MEASURED** | Queued (cheap extension of `browser-latency.mjs`). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Queued. |
