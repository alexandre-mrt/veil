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

## Constraint decomposition (which gadgets cost what)

Measured 2026-09-07 by isolating each circomlib template used by the three circuits behind its own
`component main` and compiling each in isolation with the same `circom` binary — see
[`2026-09-07-poseidon-constraint-decomposition.md`](2026-09-07-poseidon-constraint-decomposition.md).
The sum of isolated gadget costs plus each circuit's own top-level arithmetic/boolean assertions
("glue") reproduces the exact totals above, constraint for constraint.

| Gadget (one instance) | Non-linear | Linear | Total |
|---|---|---|---|
| `Poseidon(2)` | 243 | 274 | 517 |
| `Poseidon(3)` | 264 | 341 | 605 |
| `Poseidon(4)` | 300 | 436 | 736 |
| `Poseidon(5)` | 324 | 511 | 835 |
| `MerkleProof(20)` (20×`Poseidon(2)` + path-selection mux) | 4,920 | 5,480 | 10,400 |
| `Num2Bits(64)` | 64 | 1 | 65 |
| `Num2Bits(8)` | 8 | 1 | 9 |
| `GreaterThan(64)` / `GreaterEqThan(64)` / `LessEqThan(64)` | 65 | 3–4 | 68–69 |
| `GreaterEqThan(8)` | 9 | 4 | 13 |

Each additional Merkle-tree level costs exactly 517 constraints (one `Poseidon(2)` plus 3 non-linear
mux/boolean constraints, 0 extra linear) — a real per-level price for anonymity-set-size trade-offs.

| Circuit | Poseidon share of total constraints | Of which: the depth-20 Merkle path alone |
|---|---|---|
| `transfer.circom` | 97.1% (13,213 / 13,611) | 76.4% (10,400 / 13,611) |
| `compliance.circom` | 97.7% (12,445 / 12,743) | 81.6% (10,400 / 12,743) |
| `withdraw.circom` (no Merkle path) | 89.1% (2,725 / 3,058) | — |

Reproduce: `bash scripts/bench/constraint-decomposition.sh` (needs `circom` 2.2.x on `PATH` and
`circuits/node_modules` installed).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** (re-confirmed 2026-09-07) | No `sui` CLI binary reachable (GitHub access is scoped to this repo only, and building the full Sui workspace from source remains impractical within one night's budget), and direct JSON-RPC to a public Sui fullnode is denied by this session's egress policy (`connect_rejected`, confirmed via the proxy status endpoint — a clean policy denial, not a flaky error). Needs an environment-level change (network/GitHub-scope policy), not another in-session attempt. See the 2026-09-07 report for full evidence. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). Currently also blocked by the ptau-hosting issue below (no zkey can be produced to prove with). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |
| Reproducing this file's own proving-time numbers via `circuits/scripts/compile*.sh` | **BLOCKED** (new, 2026-09-07) | The documented ptau URL (`storage.googleapis.com/zkevm/ptau/...`) now returns `403 AccessDenied` from Google Cloud Storage itself (confirmed reproducible, not a network-policy block); two alternate mirrors also failed. This file's existing proving-time figures are unaffected (measured 2026-07-22 while the bucket worked), but nobody can currently regenerate a zkey by following `README.md`'s documented steps. See the 2026-09-07 report. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
