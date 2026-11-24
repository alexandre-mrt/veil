# Veil performance baseline

Circuit/proving rows measured 2026-07-22; on-chain gas and Move-suite rows measured 2026-11-24
([`2026-11-24-onchain-gas-baseline.md`](2026-11-24-onchain-gas-baseline.md)). Each section names its run. See
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

## On-chain gas per entry point (2026-11-24)

Measured on a `sui start` localnet, sui 1.71.1-2f5992f189cd, reference gas price 1000 MIST, real
Groth16 proofs for every verifying call. Every row is `effects.gasUsed` of an executed transaction.
Gas is deterministic: three full runs gave identical rows. **net** = computation + storage − rebate
(MIST). Computation is bucketed by Sui, and 1,000 units is the minimum charge.

| Entry point | Computation units | Storage | Rebate | Net (MIST) |
|---|---|---|---|---|
| `pool::deposit_and_register` | 1,000 | 13,832,000 | 11,662,200 | 3,169,800 |
| `pool::shielded_transfer` (steady state) | 1,000 | 14,485,600 | 12,369,456 | 3,116,144 |
| `compliance::compliant_transfer` (2 proofs) | 1,000 | 22,800,000 | 18,509,040 | 5,290,960 |
| `pool::zk_withdraw` | 1,000 | 15,823,200 | 12,369,456 | 4,453,744 |
| `pool::create_pool` | 1,000 | 8,496,800 | 978,120 | 8,518,680 |
| `compliance::create_compliance_config` | 1,000 | 18,171,600 | 11,609,532 | 7,562,068 |
| `pool::update_commitment_root` | 1,000 | 12,213,200 | 11,850,300 | 1,362,900 |
| `pool::propose_vk_update` / `propose_withdraw_vk` | 1,000 | 15,686,400 / 11,726,800 | 11,850,300 / 8,411,832 | 4,836,100 / 4,314,968 |
| `pool::freeze_pool` / `unfreeze_pool` | 1,000 | 11,970,000 | 11,850,300 | 1,119,700 |
| other admin ops (propose/cancel withdrawal, compliance toggle, credential root) | 1,000 | 8.96M–12.27M | 8.63M–12.15M | 0.82M–1.42M |
| package publish (6 modules) | 1,390 | 156,415,600 | 9,781,200 | 148,024,400 |

Groth16 primitives (`sui::groth16`, transfer VK, 7 public inputs): one prepare + verify is about
273 units (64× in one PTB = 17,500), of which `prepare_verifying_key` is about 85 (64× = 5,410).
One verify is therefore far below the 1,000-unit floor, and verification is not where Veil's gas
goes. On-chain VK bytes: transfer 488, withdraw 424, compliance 456.

Reproduce: `node scripts/bench/gas-localnet.ts --transfers 3` (prerequisites in its header).

Caveat: these are the costs of the contracts *as they stand*, and those contracts have three
demonstrated soundness gaps (E4, E7, BIND in the 2026-11-24 report). Fixing E7 adds one on-chain
Poseidon call to `zk_withdraw`, and fixing BIND adds a public input to `transfer.circom`. Re-run the
harness after each fix and replace these rows in place. Circuit artifacts for this run used the PSE
perpetual powers-of-tau `ppot_0080_15` (the Hermez URL returned 403 from the sandbox). Constraint
counts and VK sizes do not depend on the ptau.

## Move contract test suite (2026-11-24)

`sui move test` (sui 1.71.1): **124 / 124 passed**, 5.6 s.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |
| Shared-`Pool` contention (concurrent transfers/sec on one shared object) | **NOT MEASURED** | Every user entry point takes `&mut Pool`; queued. |
| Gas on testnet/mainnet | **NOT MEASURED** | Localnet only. Computation units should carry over at the same protocol version; MIST scales with that network's reference gas price. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
