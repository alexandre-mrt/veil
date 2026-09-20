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

Measured 2026-09-20 on a local Sui network (`sui`/`sui-node` 1.72.1, `94ad8ccd0ed6` — the exact
commit `contracts/Move.toml` pins), real successful transactions, `effects.gasUsed` read directly.
See [`2026-09-20-onchain-gas-localnet.md`](2026-09-20-onchain-gas-localnet.md) for the full
methodology (why a local network is the right substitute when every Sui JSON-RPC host is
egress-blocked) and raw command output. Net MIST = `computationCost + storageCost − storageRebate`.

| Entry point | Computation | Storage | Rebate | Net MIST | Net SUI |
|---|---|---|---|---|---|
| `publish` (whole package) | 1,370,000 | 156,415,600 | 0 | 157,785,600 | 0.157786 |
| `create_pool` | 1,000,000 | 8,496,800 | 0 | 9,496,800 | 0.009497 |
| `token_faucet::faucet` | 1,000,000 | 4,043,200 | 1,700,424 | 3,342,776 | 0.003343 |
| `deposit_and_register` | 1,000,000 | 9,021,200 | 7,245,612 | 2,775,588 | 0.002776 |
| `update_commitment_root` (admin) | 1,000,000 | 8,740,000 | 7,433,712 | 2,306,288 | 0.002306 |
| `create_compliance_config` (admin) | 1,000,000 | 14,941,600 | 7,674,480 | 8,267,120 | 0.008267 |
| `propose_withdraw_vk` (admin) | 1,000,000 | 11,726,800 | 7,433,712 | 5,293,088 | 0.005293 |
| `shielded_transfer` (1 Groth16 proof) | 1,000,000 | 11,012,400 | 8,193,636 | 3,818,764 | 0.003819 |
| `compliant_transfer` (2 Groth16 proofs) | 1,000,000 | 19,326,800 | 14,333,220 | 5,993,580 | 0.005994 |
| `zk_withdraw` (1 Groth16 proof) | 1,000,000 | 15,580,000 | 11,150,568 | 5,429,432 | 0.005429 |
| `freeze_pool` / `unfreeze_pool` (admin) | 1,000,000 | 8,496,800 | 7,433,712 | 2,063,088 | 0.002063 |

Reproduce: `scripts/bench/onchain-gas.mjs` (needs a version-matched `sui` CLI and a funded local
network — see the script's header comment and the experiment report for exact setup).

**Notable finding:** computation cost is identical (1,000,000 MIST) across every call above,
whether it verifies zero, one, or two Groth16 proofs — Sui's computation-cost bucketing absorbs the
difference at this scale. The real cost differentiator across entry points is storage (dynamic
field writes, owned-object creation), not circuit size: `zk_withdraw` costs more net gas than
`shielded_transfer` despite its circuit having 4.4x fewer R1CS constraints. See the experiment
report for what this implies for the Poseidon2 experiment (queue item 3): it should be expected to
move proving time, not on-chain gas.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope so far; queued. |
| Gas under shared-object contention (concurrent transfers on one `Pool`) | **NOT MEASURED** | The 2026-09-20 gas run above is strictly sequential on an idle single-validator network — no congestion pricing, no consensus delay from competing writers. A materially different question from single-call gas cost. |

Whatever comes out of a future measurement run should replace the corresponding row above in
place, not be appended as a separate table.
