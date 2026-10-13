# Veil performance baseline

Measured 2026-07-22 (circuits, proving) and 2026-10-13 (on-chain gas), each in one run. See
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

## On-chain gas per entry point (2026-10-13, local Sui network, `sui 1.81.1`, RGP 1000 MIST)

Real Groth16 proofs verified by `sui::groth16`. Full method, raw output and caveats:
[`2026-10-13-onchain-gas-baseline.md`](2026-10-13-onchain-gas-baseline.md). Computation is billed at
a 1,000-unit floor; every entry point below except `publish` sits on it.

| Entry point | Computation (MIST) | Net storage (MIST) | **Net total (MIST)** |
|---|---|---|---|
| `publish` | 1,380,000 | 151,525,000 | 152,905,000 |
| `create_pool` | 1,000,000 | 7,518,680 | 8,518,680 |
| `deposit_and_register` | 1,000,000 | 797,468 | 1,797,468 |
| `update_commitment_root` (propose) | 1,000,000 | 328,168 | 1,328,168 |
| `propose_withdraw_vk` | 1,000,000 | 3,317,400 | 4,317,400 |
| `create_compliance_config` | 1,000,000 | 6,321,300 | 7,321,300 |
| `shielded_transfer` | 1,000,000 | 1,875,376 | 2,875,376 |
| `zk_withdraw` | 1,000,000 | 3,453,744 | 4,453,744 |
| `propose_compliance_toggle` | 1,000,000 | 127,300 | 1,127,300 |
| `compliant_transfer` (2 proofs) | 1,000,000 | 4,281,004 | 5,281,004 |

Marginal `sui::groth16` compute (units, transfer circuit): `prepare_verifying_key` 84, verify with a
prepared key 183, both (today's `verifier.move`) 268. Reproduce: `node scripts/bench/gas-localnet.ts`
and `node scripts/bench/gas-probe.ts` from `scripts/` with a running localnet.

Move contract suite: `sui move test` — 124/124 passing (2026-10-13).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future run for these rows should replace them in place, not be appended as
a separate table.
