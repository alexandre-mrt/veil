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
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** (3 attempts: 2026-07-22, 2026-11-14) | No `sui` CLI. GitHub release assets are out of the session's scope. Testnet JSON-RPC (`fullnode.testnet.sui.io`) is 403 at the egress proxy. Docker Hub is reachable and `mysten/sui-tools:testnet` carries a prebuilt `sui`, but fetching that layer was denied by the session permission layer (2026-11-14). A from-source build was not attempted within a single night. Unblock: owner approves the Docker Hub layer fetch, or allowlists the testnet fullnode, or budgets a from-source build. See [`2026-11-14-poseidon2-merkle-arity.md`](2026-11-14-poseidon2-merkle-arity.md) §Item #1. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

## Measured but not adopted (2026-11-14)

These are not production numbers (production still compiles at circom's default `-O1`); they are
recorded so the next experiment has a reference point. Different machine from the table above —
production `transfer` at `-O1` measured 693.7 ms there. Source:
[`2026-11-14-poseidon2-merkle-arity.md`](2026-11-14-poseidon2-merkle-arity.md).

| Circuit | `-O1` prove (ms) | `-O2` prove (ms) | `-O1` → `-O2` |
|---|---|---|---|
| `transfer.circom` | 693.7 (σ 31.6) | 520.7 (σ 10.8) | −24.9% |
| `compliance.circom` | 628.7 (σ 13.7) | 511.8 (σ 23.3) | −18.6% |

Reproduce: `node scripts/bench/hash-arity/bench.mjs --ptau <pot14+> --runs 10 [--prove-opt O2]`.

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
