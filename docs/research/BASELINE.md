# Veil performance baseline

Constraint counts and Node proving time measured 2026-08-22 (`circom --O2`, full constraint
simplification — see [`2026-08-22-poseidon2-hash-swap.md`](2026-08-22-poseidon2-hash-swap.md)).
Browser proving time and artifact-size figures below are still the 2026-07-22 `--O1` run (see
[`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md)) — not yet
re-measured at `--O2`, see "Not yet measured". Superseded rows are replaced in place with a note
in `LEDGER.md` pointing at the experiment that changed them — this file always reflects the
current state of the protocol, not history.

Toolchain: circom 2.2.2 (built from source, `iden3/circom` tag `v2.2.2`), snarkjs 0.7.6, Node
v22.22.2, pot15 Powers of Tau (Hermez, `2^15` — reused for all three circuits per the existing
`compile*.sh` scripts), single dev-only Groth16 contribution (matches
`circuits/scripts/compile*.sh` — **not** a production ceremony; see `ceremony.sh` and
`docs/threat-model.md` RR2). `circuits/scripts/compile*.sh` now pass `--O2`; the 2026-07-22 run
used circom's `--O1` default.

## Constraint counts, artifact sizes (`--O2`, 2026-08-22)

| Circuit | R1CS constraints | Non-linear | Linear | Wires | Public / private inputs | zkey (bytes) | vk (bytes) | Compressed on-chain proof (bytes) |
|---|---|---|---|---|---|---|---|---|
| `transfer.circom` | 6,384 | 6,384 | 0 | 6,407 | 7 / 47 | 4,466,618 | 4,026 | 128 |
| `compliance.circom` | 5,979 | 5,979 | 0 | 5,998 | 6 / 45 | 3,785,562 | 3,841 | 128 |
| `withdraw.circom` | 1,439 | 1,439 | 0 | 1,441 | 5 / 5 | 1,608,154 | 3,655 | 128 |

(`--O1`, 2026-07-22, for comparison — see `docs/research/2026-08-22-poseidon2-hash-swap.md` for
the full O1-vs-O2 delta including *why* `withdraw`'s zkey grew despite fewer constraints):
transfer 13,611 (6,470 NL / 7,141 lin, zkey 6,001,431 B); compliance 12,743 (6,057 NL / 6,686
lin, zkey 5,682,155 B); withdraw 3,058 (1,465 NL / 1,593 lin, zkey 1,385,335 B).

Groth16 proofs are three fixed-size group elements (2×G1 + 1×G2) regardless of circuit — the
128-byte compressed on-chain figure (from `scripts/src/test-converter.ts`, `proofToSuiBytes`) is
constant across all three circuits and unaffected by the O1→O2 change. snarkjs's own JSON proof
encoding (decimal-string field elements) runs ~721–726 bytes for the same data.

## Proving time (mean of 10 runs, includes witness generation)

| Circuit | Node.js, `--O2` (this machine, 2026-08-22) | Node.js, `--O1` (2026-08-22, same session) | Chromium, `--O1` (2026-07-22, different machine) |
|---|---|---|---|
| `transfer.circom` | 699.0 ms (σ 13.7) | 908.8 ms (σ 21.9) | 1213.3 ms (σ 32.6, 8 runs) |
| `compliance.circom` | 665.7 ms (σ 19.4) | 877.8 ms (σ 17.1) | 1163.4 ms (σ 58.6, 8 runs) |
| `withdraw.circom` | 276.2 ms (σ 12.2) | 291.5 ms (σ 10.5) | 382.9 ms (σ 9.9, 8 runs) |

The `--O1` column is a fresh same-session, same-machine re-measurement (not the 2026-07-22
numbers, which ran on different hardware) — a clean same-machine O1-vs-O2 delta. The Chromium
column is still the 2026-07-22 `--O1` browser run; not yet re-measured against `--O2` artifacts
(see "Not yet measured").

Reproduce: `node scripts/bench/prove-latency.mjs --runs 10` (O2, against
`circuits/build{,-withdraw,-compliance}/`),
`node scripts/bench/optimization-latency.mjs --runs 10` (O1 vs O2 vs the parked Poseidon2 variant
side by side — see `circuits/scripts/setup-variant.sh` for how to build the O1 comparison
artifacts), and `node scripts/bench/browser-latency.mjs --runs 8` (see that directory for
prerequisites).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** (3rd attempt, 2026-08-22) | No `sui` CLI on crates.io; `github.com` release-asset downloads and direct JSON-RPC to `fullnode.testnet.sui.io` both return `403` (egress policy denial, confirmed via the proxy status endpoint — distinct from `git clone`/`ls-remote` access to `github.com`, which *is* permitted and is how `circom` itself gets built each session). Building the full Sui workspace from source remains impractical within one night's budget. See `docs/research/2026-08-22-poseidon2-hash-swap.md` for the precise root-cause this time. Still top of the queue. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Browser (Chromium) proving latency at `--O2` | **NOT MEASURED** | 2026-08-22 only re-measured Node proving time at O2; the Chromium harness (`browser-latency.mjs`) was not re-run against the new O2 `build{,-withdraw,-compliance}/` artifacts. Cheap follow-up — same harness, no code changes needed. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
