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

2026-08-06 re-confirmed every constraint count above byte-for-byte using a different circom
distribution — `npm install --no-save circom2` (WASM build, `registry.npmjs.org`, reports
`circom compiler 2.2.3`) — needed because that session's sandbox blocked GitHub/crates.io outright
(see `2026-08-06-poseidon-constraint-decomposition.md`). Either toolchain reproduces these numbers;
`circom2` needs no from-source build step.

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

## Non-linear constraint decomposition, per gadget

Measured 2026-08-06 — see
[`2026-08-06-poseidon-constraint-decomposition.md`](2026-08-06-poseidon-constraint-decomposition.md)
for the full methodology and raw output. Supersedes the informal claim in `EXPERIMENTS.md` (pre
2026-08-06) that "four Poseidon instances dominate" `transfer.circom` and `compliance.circom`'s
non-linear constraints — true for `withdraw.circom` (no Merkle proof), **not** true for the other
two, where the 20-level Merkle-membership proof dominates instead.

| Gadget | Non-linear | Linear |
|---|---|---|
| `Poseidon(2)` | 243 | 274 |
| `Poseidon(3)` | 264 | 341 |
| `Poseidon(4)` | 300 | 436 |
| `Poseidon(5)` | 324 | 511 |
| `MerkleProof(20)` (= 20×`Poseidon(2)` + `MultiMux1(2)` selectors) | 4,920 | 5,480 |
| `Num2Bits(64)` | 64 | 1 |
| `Num2Bits(8)` | 8 | 1 |
| `LessEqThan(64)` / `GreaterThan(64)` / `GreaterEqThan(64)` | 65 | 3–4 |
| `GreaterEqThan(8)` | 9 | 4 |

**246 non-linear constraints per Merkle level** (243 hash + 3 selector overhead) — the number to
use for costing any future Merkle-depth change (RR5, anonymity-set size vs. prover time).

| Circuit | Dominant non-linear contributor | Share |
|---|---|---|
| `transfer.circom` | `MerkleProof(20)` | 76.05% |
| `compliance.circom` | `MerkleProof(20)` | 81.26% |
| `withdraw.circom` (no Merkle proof) | `Poseidon(4)`×3 + `Poseidon(2)`×1 | 78.02% |

Reproduce: `bash scripts/bench/gadget-constraints.sh` (compiles the eleven isolated gadgets under
`circuits/bench/`).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** | No `sui` CLI binary available or installable in this session (no prebuilt binary reachable, building the full Sui workspace from source was judged impractical within a single night's budget), and ad-hoc JSON-RPC calls to a public Sui endpoint were not attempted after an early network-call permission denial in the same session (see the experiment report). Top of the queue for the next run. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
