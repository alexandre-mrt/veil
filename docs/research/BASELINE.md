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

## Alternative constructions (research only — not deployed)

Not part of the current protocol. These are measured numbers for variant circuits that exist
only under `circuits/bench/poseidon2/full/` for benchmarking — no trusted setup for them was
ever deployed, `pool.move`'s VKs are unchanged, and the frontend still proves against the
circuits in the main table above. See
[`2026-08-27-poseidon2-hash-swap.md`](2026-08-27-poseidon2-hash-swap.md) for the full
methodology, soundness argument, and negative test.

### Poseidon (current) vs Poseidon2 (`@taceo/circom-lib`, tag moved from rate to capacity)

| Circuit | Poseidon constraints | Poseidon2 constraints | Δ constraints | Poseidon proving (Node, mean of 10) | Poseidon2 proving (Node, mean of 10) | Δ proving |
|---|---|---|---|---|---|---|
| `transfer` | 13,611 | 15,194 | +11.6% | 788.3 ms | 745.7 ms | **-5.4%** |
| `withdraw` | 3,058 | 3,372 | +10.3% | 272.6 ms | 236.4 ms | **-13.3%** |
| `compliance` (partial swap — leaf hash unchanged, no Poseidon2 t=5 parameters published) | 12,743 | 13,953 | +9.5% | 762.1 ms | 763.0 ms | +0.1% (noise) |

Reproduce: `node scripts/bench/poseidon2-full-circuit.mjs --runs 10` (full circuits) and
`node scripts/bench/poseidon2-constraint-delta.mjs --runs 10` (isolated per-shape
microbenchmark). Total R1CS constraints go up for every shape/circuit despite proving time
going down — the swap's non-linear (S-box) constraint count drops while linear-layer
constraints grow faster than they shrink, but proving time is driven by non-linear
(witness-generation) cost, not total count, as long as the swap doesn't push a circuit over
its next power-of-two constraint boundary (it doesn't, for any of the three circuits here).
