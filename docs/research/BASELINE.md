# Veil performance baseline

Measured 2026-07-22 (circuits, proving) and 2026-10-30 (on-chain gas, Move suite), on one machine, in one run each. See
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

## On-chain gas per entry point (localnet, sui 1.72.5, RGP 1000 MIST/unit; MIST, net = comp + storage − rebate)

Measured 2026-10-30 — see [`2026-10-30-onchain-gas-baseline.md`](2026-10-30-onchain-gas-baseline.md) for method, caveats (synthetic
VK/proofs of real shape; localnet) and raw output. Reproduce: `bun run bench/gas-localnet.ts` from `scripts/`.

| Entry point | Computation | Net |
|---|---:|---:|
| `create_pool` | 1,000,000 | 8,518,680 |
| `deposit_and_register` | 1,000,000 | 1,829,768 |
| `shielded_transfer` | 1,000,000 (floor; ≈340,000 actual) | 3,113,712 |
| `zk_withdraw` | 1,000,000 | 4,451,312 |
| `shielded_transfer`, invalid proof | 1,000,000 | 1,101,992 |
| admin ops (freeze, propose/cancel VK, withdrawal) | 1,000,000 | −2,561,968 … 4,833,668 |
| N transfers in one PTB (N=5/10/20) | — | −23% / −24% / −24% per transfer; cliff by N=40 (+87%) |

Computation is pinned at Sui's minimum bucket for every single call; cost is dominated by storage.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Compliance verify gas, `emergency_withdraw`, behaviour under concurrent load | **NOT MEASURED** | Not covered by the 2026-10-30 gas harness; see its open questions. |
| Real-circuit proofs on chain (vs synthetic VK) | **NOT MEASURED** | circom could not be built on 2026-10-30. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Move contract test suite: **124/124 pass** (`sui move test`, CLI 1.72.5, 2026-10-30).

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
