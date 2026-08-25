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

## Constraint attribution (by gadget)

Measured 2026-08-25 — see
[`2026-08-25-poseidon-constraint-attribution.md`](2026-08-25-poseidon-constraint-attribution.md).
Every gadget below is an isolated single-component circuit compiled with `circom2`; the "predicted"
row for each real circuit is `sum(gadget non-linear/linear × call count)`, cross-checked against the
constraint totals above (both fully independent measurements — not just re-parsing the same number).

| Gadget | Non-linear | Linear | Total |
|---|---|---|---|
| `Poseidon(2)` | 243 | 274 | 517 |
| `Poseidon(3)` | 264 | 341 | 605 |
| `Poseidon(4)` | 300 | 436 | 736 |
| `Poseidon(5)` | 324 | 511 | 835 |
| One Merkle-tree level (`MultiMux1(2)` + boolean check + `Poseidon(2)`) | 246 | 274 | 520 |
| `Num2Bits(64)` | 64 | 1 | 65 |
| `Num2Bits(8)` | 8 | 1 | 9 |
| `GreaterThan(64)` | 65 | 3 | 68 |
| `LessEqThan(64)` | 65 | 4 | 69 |
| `GreaterEqThan(64)` | 65 | 4 | 69 |
| `GreaterEqThan(8)` | 9 | 4 | 13 |

| Circuit | Merkle path (20 levels) | Direct Poseidon hashes | All Poseidon | Range checks + comparators | Reconstruction error |
|---|---|---|---|---|---|
| `transfer.circom` | 4,920 (76.0%) | 1,164 (18.0%) | 6,084 (94.0%) | 386 (6.0%) | 0 non-linear / -1 linear |
| `compliance.circom` | 4,920 (81.2%) | 852 (14.1%) | 5,772 (95.3%) | 282 (4.7%) | -3 non-linear / 0 linear |
| `withdraw.circom` (no Merkle tree) | — | 1,143 (78.0%) | 1,143 (78.0%) | 322 (22.0%) | 0 non-linear / -1 linear |

The Merkle-membership path alone — not the fixed-arity commitment/nullifier/credential hashes — is
the single largest constraint block in both circuits that have one, bigger than every direct
Poseidon call combined. Reproduce: `node scripts/bench/gadget-attribution.mjs [--prove]`.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** | No `sui` CLI binary available or installable in this session (no prebuilt binary reachable, building the full Sui workspace from source was judged impractical within a single night's budget), and ad-hoc JSON-RPC calls to a public Sui endpoint were not attempted after an early network-call permission denial in the same session (see the experiment report). Top of the queue for the next run. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
