# Veil performance baseline

Measured 2026-07-22 (constraints, sizes, proving time) and 2026-10-22 (on-chain gas), each on one machine in one run. See
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

## On-chain gas (Sui 1.72.2 localnet, real proofs, MIST; reference gas price 1000)

Measured 2026-10-22, [`2026-10-22-onchain-gas.md`](2026-10-22-onchain-gas.md). Reproduce:
`node scripts/bench/gas-localnet.mjs` and `node scripts/bench/gas-verify-sweep.mjs` against `sui start --force-regenesis --with-faucet`.

| Entry point | computation | storage | rebate | net |
|---|---|---|---|---|
| publish (package) | 1,390,000 | 156,415,600 | 9,781,200 | 148,024,400 |
| create_pool | 1,000,000 | 8,496,800 | 978,120 | 8,518,680 |
| deposit_and_register (1000 / 100 denom) | 1,000,000 | 9,021,200 / 10,358,800 | 8,223,732 | 1,797,468 / 3,135,068 |
| update_commitment_root (propose) | 1,000,000 | 8,740,000 | 8,411,832 | 1,328,168 |
| propose_withdraw_vk | 1,000,000 | 11,970,000 | 8,652,600 | 4,317,400 |
| create_compliance_config | 1,000,000 | 14,941,600 | 8,652,600 | 7,289,000 |
| freeze_pool / unfreeze_pool | 1,000,000 | 8,983,200 | 8,893,368 | 1,089,832 |
| shielded_transfer | 1,000,000 | 14,242,400 | 12,369,456 | 2,872,944 |
| zk_withdraw | 1,000,000 | 15,580,000 | 12,128,688 | 4,451,312 |
| compliant_transfer (2 proofs) | 1,000,000 | 19,326,800 | 15,311,340 | 5,015,460 |
| replayed shielded_transfer (aborts) | 1,000,000 | 10,199,200 | 10,097,208 | 1,101,992 |

Every call sits on Sui's 1,000-unit computation floor. True native cost (sweep, units = 1000 MIST each):
prepare VK + verify = 267.2, prepare alone = 83.6, verify with prepared VK = 183.6. ~3.7 verifications fit under the floor.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Move contract suite: `sui move test` → 124/124 passed (2026-10-22, framework rev 94ad8ccd).
Storage price, reference gas price and the computation floor are network constants; mainnet/testnet values were not reachable from the sandbox.
