# Veil performance baseline

Originally measured 2026-07-22. Updated 2026-08-04: `circuits/scripts/compile{,-compliance,-withdraw}.sh`
now compile with `--O2` (full constraint simplification) instead of circom's default (`--O1`) — see
[`2026-08-04-poseidon2-vs-poseidon.md`](2026-08-04-poseidon2-vs-poseidon.md) for the full methodology and
raw command output. This file always reflects the **current** state of the protocol (i.e. what a fresh
`bash scripts/compile*.sh` run produces today), not history — superseded numbers are replaced in place,
with a note in `LEDGER.md` pointing at the experiment that changed them.

Toolchain: circom 2.2.2 (built from source, `iden3/circom` tag `v2.2.2`), snarkjs 0.7.6, Node
v22.22.2, Chromium 141 (headless, via Playwright), pot15 Powers of Tau (Hermez, `2^15` — reused
for all three circuits per the existing `compile*.sh` scripts), single dev-only Groth16
contribution (matches `circuits/scripts/compile*.sh` — **not** a production ceremony; see
`ceremony.sh` and `docs/threat-model.md` RR2).

**Operational note:** switching to `--O2` changes the compiled R1CS and therefore every verifying key.
An existing on-chain deployment must go through the timelocked VK-update path (`docs/threat-model.md`
T3) to pick this up — not a silent redeploy.

## Constraint counts, artifact sizes

| Circuit | R1CS constraints | Non-linear | Linear | Wires | Public / private inputs | zkey (bytes) | vk (bytes) | Compressed on-chain proof (bytes) |
|---|---|---|---|---|---|---|---|---|
| `transfer.circom` | 6,384 | 6,384 | 0 | 6,407 | 7 / 47 | 4,466,605 | 4,027 | 128 |
| `compliance.circom` | 5,979 | 5,979 | 0 | 5,998 | 6 / 45 | 3,785,549 | 3,840 | 128 |
| `withdraw.circom` | 1,439 | 1,439 | 0 | 1,441 | 5 / 5 | 1,608,141 | 3,653 | 128 |

Groth16 proofs are three fixed-size group elements (2×G1 + 1×G2) regardless of circuit — the
128-byte compressed on-chain figure (from `scripts/src/test-converter.ts`, `proofToSuiBytes`) is
constant across all three circuits. snarkjs's own JSON proof encoding (decimal-string field
elements) runs ~721–727 bytes for the same data.

**Prior (`--O1`, default) numbers, for comparison** — reproduce either with
`bash scripts/bench/o1-vs-o2-constraints.sh`:

| Circuit | R1CS constraints (O1) | Non-linear | Linear | zkey (bytes, O1) | Δ constraints | Δ zkey |
|---|---|---|---|---|---|---|
| `transfer.circom` | 13,611 | 6,470 | 7,141 | 6,001,417 | −53.1% | −25.6% |
| `compliance.circom` | 12,743 | 6,057 | 6,686 | 5,682,141 | −53.1% | −33.4% |
| `withdraw.circom` | 3,058 | 1,465 | 1,593 | 1,385,321 | −52.9% | **+16.1%** |

`withdraw.circom`'s zkey *grows* under `--O2` despite fewer constraints and fewer wires — zkey size
tracks nonzero sparse-matrix coefficients, not constraint count directly; see the report for why.

## Proving time (mean of 10 runs Node / 8 runs browser, includes witness generation)

| Circuit | Node.js (this machine) | Chromium (headless, this machine) | Browser / Node ratio |
|---|---|---|---|
| `transfer.circom` | 613.8 ms (σ 14.3) | 963.5 ms (σ 153.3, 8 runs) | 1.57x |
| `compliance.circom` | 576.8 ms (σ 14.0) | 871.8 ms (σ 100.9, 8 runs) | 1.51x |
| `withdraw.circom` | 234.4 ms (σ 8.1) | 375.1 ms (σ 39.1, 8 runs) | 1.60x |

Prior (`--O1`) proving time, for comparison: transfer 769.8ms / compliance 760.9ms / withdraw 256.1ms
(Node); transfer 1213.3ms / compliance 1163.4ms / withdraw 382.9ms (browser). `--O2` is 8.5–24.2% faster
on Node, 2.0–25.1% faster in-browser, across all three circuits.

Reproduce: `node scripts/bench/prove-latency.mjs --runs 10` and
`node scripts/bench/browser-latency.mjs --runs 8` (see that directory for prerequisites — circuits must
be compiled with the current `compile*.sh` scripts, i.e. `--O2`, first).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** | Reconfirmed 2026-08-04 with a more specific diagnosis: direct JSON-RPC to `fullnode.testnet.sui.io` gets a hard `403` at the sandbox's network proxy (standing policy denial, not a one-off tool-approval prompt), and `cargo install`-ing the `sui` CLI is blocked because `static.crates.io` (crate downloads) returns `403` even though the registry index is reachable. Looks structural to this sandbox's network policy. Top of the queue again. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed 2026-08-04 either; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Unchanged since 2026-07-22 — natural, cheap follow-up (`page.emulate` a device descriptor in the existing browser harness). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope so far; queued. |
| Poseidon2 at t=4/t=5 (Veil's dominant Poseidon width) | **NOT MEASURED** | No official BN254 parameters exist upstream at these widths (t=3 is the only one published); see 2026-08-04 report. REJECTED at t=3 (ties at `--O2`, loses at `--O1`) — not worth pursuing further without first solving the t=5 parameter gap. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
