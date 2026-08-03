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

## Constraint attribution by gadget (added 2026-08-03)

Every non-linear constraint in the three circuits above, attributed to a specific gadget via
isolated single-gadget `circom` compiles, reconciled exactly against a fresh full-circuit compile.
See [`2026-08-03-poseidon-constraint-attribution.md`](2026-08-03-poseidon-constraint-attribution.md)
for the full methodology and raw output; reproduce with
`bash scripts/bench/poseidon-constraint-attribution.sh`.

| Gadget | Non-linear constraints (each) |
|---|---|
| `Poseidon(2)` (t=3) | 243 |
| `Poseidon(3)` (t=4) | 264 |
| `Poseidon(4)` (t=5) | 300 |
| `Poseidon(5)` (t=6) | 324 |
| `Num2Bits(64)` | 64 |
| `Num2Bits(8)` | 8 |
| `GreaterThan(64)` | 65 |
| `LessEqThan(64)` | 65 |
| `GreaterEqThan(64)` | 65 |
| `GreaterEqThan(8)` | 9 |
| `MultiMux1(2)` | 2 |
| `MerkleProof(20)` (full template: 20×`Poseidon(2)` + 20×`MultiMux1(2)` + 20×boolean check) | 4,920 |

| Circuit | Pure-Poseidon share | `MerkleProof(20)` share | Non-Poseidon (range/comparator) share |
|---|---|---|---|
| `transfer.circom` | 93.1% (6,024 / 6,470) | 76.0% (4,920 / 6,470) | 6.9% (446 / 6,470) |
| `compliance.circom` | 94.3% (5,712 / 6,057) | 81.2% (4,920 / 6,057) | 5.7% (345 / 6,057) |
| `withdraw.circom` | 78.0% (1,143 / 1,465) | n/a (no Merkle proof) | 22.0% (322 / 1,465) |

**Key finding:** in both `transfer.circom` and `compliance.circom`, the depth-20 Merkle
authentication path alone — not any individual commitment/nullifier/credential hash — accounts
for 76–81% of non-linear constraints. Each additional tree depth level costs exactly 245
non-linear constraints (one `Poseidon(2)` + one `MultiMux1(2)` + one boolean check). This is the
real lever for future anonymity-set-size work (`docs/threat-model.md` RR5), not a hash-function
version swap: Poseidon2 was evaluated and rejected as a constraint-count lever for this circuit
family under Groth16/R1CS — see the linked report for why.

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
