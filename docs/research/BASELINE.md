# Veil performance baseline

Measured 2026-07-22 (updated 2026-10-23: circuits now built with `circom --O2`), each table from one machine in one run. See
[`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md) for the full
methodology, raw command output, and what's still missing. Superseded rows should be replaced in
place with a note in `LEDGER.md` pointing at the experiment that changed them — this file always
reflects the current state of the protocol, not history.

Toolchain: circom 2.2.2 (built from source, `iden3/circom` tag `v2.2.2`), snarkjs 0.7.6, Node
v22.22.2, Chromium 141 (headless, via Playwright), pot15 Powers of Tau (Hermez, `2^15` — reused
for all three circuits per the existing `compile*.sh` scripts), single dev-only Groth16
contribution (matches `circuits/scripts/compile*.sh` — **not** a production ceremony; see
`ceremony.sh` and `docs/threat-model.md` RR2).

## Constraint counts, artifact sizes (current build: `circom --O2`, measured 2026-10-23)

Rows replaced in place by [`2026-10-23-poseidon2-circuit-cost.md`](2026-10-23-poseidon2-circuit-cost.md).
Machine: 4 vCPU Xeon @ 2.80GHz, Node v22.22.0, circom 2.2.2, snarkjs 0.7.6, **locally generated dev-only
pot15** (the Hermez download was proxy-blocked that night; sizes/times don't depend on ptau entropy).

| Circuit | R1CS constraints (was, O1) | Non-linear | zkey (bytes) | vk (bytes) | Compressed on-chain proof (bytes) |
|---|---|---|---|---|---|
| `transfer.circom` | 6,384 (13,611) | 6,384 | 4,466,607 | 4,025 | 128 |
| `compliance.circom` | 5,979 (12,743) | 5,979 | 3,785,551 | 3,841 | 128 |
| `withdraw.circom` | 1,439 (3,058) | 1,439 | 1,608,143 | 3,656 | 128 |

vk and proof sizes depend only on the public-input count, not on constraints (unchanged from 2026-07-22).
Public / private inputs: transfer 7 / 47, compliance 6 / 45, withdraw 5 / 5.

## Proving time, Node (mean of 20 runs after warm-up, includes witness generation; 2026-10-23, same run)

| Circuit | `--O2` (current) | O1 (previous build, same machine/run) | Change |
|---|---|---|---|
| `transfer.circom` | 790.8 ms (σ 48.4) | 984.2 ms (σ 30.4) | −19.7% |
| `compliance.circom` | 746.7 ms (σ 40.1) | 946.8 ms (σ 38.4) | −21.1% |
| `withdraw.circom` | 292.6 ms (σ 18.6) | 345.2 ms (σ 24.2) | −15.2% |

Absolute times vary by machine state (the 2026-07-22 run measured O1 transfer at 751.9 ms); compare
only within a run. **Browser (Chromium) latency was not re-measured under `--O2`** — the 2026-07-22
figures (transfer 1213 ms, compliance 1163 ms, withdraw 383 ms) are for the O1 build. Expect the same
direction; unmeasured. The deployed testnet VKs correspond to the O1 build until a new ceremony.

Reproduce: `bash scripts/bench/poseidon2/run.sh 20` (see that dir) or `node scripts/bench/prove-latency.mjs --runs 10`.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** | No `sui` CLI binary available or installable in this session (no prebuilt binary reachable, building the full Sui workspace from source was judged impractical within a single night's budget), and ad-hoc JSON-RPC calls to a public Sui endpoint were not attempted after an early network-call permission denial in the same session (see the experiment report). Top of the queue for the next run. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
