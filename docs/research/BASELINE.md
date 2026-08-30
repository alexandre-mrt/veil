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

**Reproduction update (2026-08-30):** the original `cargo build --release` against a cloned
`iden3/circom` no longer works in every environment this loop runs in (GitHub source access isn't
always available). `circom2` (`npm install --save-dev circom2` in `circuits/`) is a WASM build of
circom compiler **2.2.3**, distributed on the npm registry, and reproduces every number below
bit-for-bit on a clean recompile — use `npx circom2 <circuit>.circom --r1cs --wasm --sym -o build
-l node_modules` in place of a native `circom` binary wherever one isn't available. It's now a
committed `devDependency`, so `npm install` in `circuits/` is sufficient.

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

## Constraint attribution (measured 2026-08-30)

What fraction of each circuit's non-linear constraints is Poseidon, vs. everything else (range
checks, comparators, the Merkle-membership template's own bookkeeping) — measured by compiling every
gadget in isolation and reconciling the sum against a fresh full-circuit compile (exact to within
0–3 constraints for all three circuits). This is the ceiling on what any future hash-function swap
(Poseidon2 or otherwise) could ever save; see
[`2026-08-30-poseidon-constraint-attribution.md`](2026-08-30-poseidon-constraint-attribution.md) for
the full per-gadget table and reconciliation.

| Circuit | Non-linear constraints | Poseidon share |
|---|---|---|
| `transfer.circom` | 6,470 | **93.1%** |
| `compliance.circom` | 6,057 | **94.3%** |
| `withdraw.circom` | 1,465 | **78.0%** (no Merkle proof — lower-leverage target) |

Reproduce: `node scripts/bench/constraint-breakdown.mjs`.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** (structural, confirmed 2026-08-30) | `sui` CLI is gated by this session's GitHub access being scoped to one repo; direct JSON-RPC to six different Sui fullnode providers all get an identical network-policy denial. Needs a human to grant GitHub access or a network-policy exception — see `EXPERIMENTS.md` item #2 and the 2026-08-30 report. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
