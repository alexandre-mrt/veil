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

## Constraint cost by gadget

Measured 2026-09-10 (see
[`2026-09-10-poseidon-constraint-breakdown.md`](2026-09-10-poseidon-constraint-breakdown.md)) by
compiling every circomlib template Veil's circuits instantiate as its own one-line circuit and
reading `snarkjs r1cs info`. Reproduce: `bash scripts/bench/circuit-gadget-cost/run.sh`.

| Gadget | Non-linear | Linear | Total |
|---|---|---|---|
| `Poseidon(2)` | 243 | 274 | 517 |
| `Poseidon(3)` | 264 | 341 | 605 |
| `Poseidon(4)` | 300 | 436 | 736 |
| `Poseidon(5)` | 324 | 511 | 835 |
| `Num2Bits(8)` | 8 | 1 | 9 |
| `Num2Bits(64)` | 64 | 1 | 65 |
| `GreaterThan(64)` | 65 | 3 | 68 |
| `GreaterEqThan(8)` | 9 | 4 | 13 |
| `GreaterEqThan(64)` | 65 | 4 | 69 |
| `LessEqThan(64)` | 65 | 4 | 69 |
| `MultiMux1(2)` | 2 | 0 | 2 |
| `MerkleProof(20)` (20× `Poseidon(2)` + 20× `MultiMux1(2)` + 20 boolean checks) | 4,920 | 5,480 | 10,400 |

These reconstruct each circuit's total constraint count exactly (component sum + a fixed, explained
correction for circom's default `--O1` signal-elimination behavior — see the report for the full
arithmetic). The headline finding: the 20-deep Merkle authentication path, not the domain-tagged
commitment/nullifier/context hashes, dominates non-linear constraints in the two circuits that have
one:

| Circuit | Total non-linear | From the Merkle path | From domain-tagged Poseidon calls |
|---|---|---|---|
| `transfer.circom` | 6,470 | 4,920 (**76.0%**) | 1,164 (18.0%) |
| `compliance.circom` | 6,057 | 4,920 (**81.2%**) | 852 (14.1%) |
| `withdraw.circom` (no Merkle path) | 1,465 | — | 1,143 (**78.0%**) |

This supersedes the "four Poseidon instances dominate" framing in `README.md`'s constraint-count
section for `transfer.circom`/`compliance.circom` specifically — that framing holds for
`withdraw.circom`, which has no Merkle path, but not for the two circuits that do.

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
