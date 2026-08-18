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

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** | No `sui` CLI binary available or installable in this session (no prebuilt binary reachable, building the full Sui workspace from source was judged impractical within a single night's budget), and ad-hoc JSON-RPC calls to a public Sui endpoint were not attempted after an early network-call permission denial in the same session (see the experiment report). Top of the queue for the next run. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.

## Poseidon2 candidate (measured, not yet deployed)

Measured 2026-08-18, same machine, same toolchain versions as above plus `@taceo/circom-lib@0.6.0`
/ `@taceo/poseidon2@0.2.0`. See
[`2026-08-18-poseidon2-vs-poseidon.md`](2026-08-18-poseidon2-vs-poseidon.md) for the full
methodology, soundness/leakage analysis, and raw output. **This is a recommendation, not a
migration** — the rows above (the deployed circuits, real testnet verifying keys) are unchanged.
`transfer_poseidon2.circom` / `compliance_poseidon2.circom` swap only the 20-level Merkle-membership
node hash (circomlib `Poseidon(2)` sponge → `Poseidon2(2)` compression mode); every other constraint
is byte-for-byte identical to the deployed circuit.

| Circuit | R1CS constraints | Δ vs. deployed | zkey (bytes) | Δ zkey | Node proving time (mean, 20 runs) | Δ proving time |
|---|---|---|---|---|---|---|
| `transfer_poseidon2.circom` | 12,951 | −4.85% (−660) | 5,742,717 | −4.31% | 860.10 ms (σ 25.91) | −4.64% |
| `compliance_poseidon2.circom` | 12,083 | −5.18% (−660) | 5,423,441 | −4.55% | 828.17 ms (σ 20.18) | −5.62% |

Adopting this for real requires a new circuit version, a fresh production-grade (multi-party)
trusted setup, new on-chain verifying keys, and a pool migration — not attempted tonight. Tonight's
zkeys for these two circuits are the same dev-only single-contributor setup as every other circuit
in this repo (not production-safe, see `docs/threat-model.md` RR2).
