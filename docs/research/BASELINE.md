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
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** | No `sui` CLI binary available or installable in this session (no prebuilt binary reachable, building the full Sui workspace from source was judged impractical within a single night's budget), and ad-hoc JSON-RPC calls to a public Sui endpoint were not attempted after an early network-call permission denial in the same session (see the experiment report). Top of the queue for the next run. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.

## Poseidon vs Poseidon2 — primitive-level benchmark (not deployed)

Measured 2026-08-29, same machine/toolchain versions as above. **This is not a production number**:
`transfer.circom`, `compliance.circom`, and `withdraw.circom` are unchanged and still use circomlib's
`Poseidon` exclusively — the circuits below live only in `circuits/bench/`, never wired into the
protocol. Included here because it's the reference point any future Poseidon2 discussion should cite
instead of re-deriving. Full methodology, correctness cross-check, and negative test:
[`2026-08-29-poseidon2-primitive-delta.md`](2026-08-29-poseidon2-primitive-delta.md).

| Comparison | Poseidon constraints (`--O1`) | Poseidon2 constraints (`--O1`) | Δ | Poseidon proving (mean, 10 runs) | Poseidon2 proving (mean, 10 runs) |
|---|---|---|---|---|---|
| `Poseidon(2)` vs `Poseidon2(t=3)` | 517 | 580 | +12.2% | 132.5 ms | 102.2 ms |
| `Poseidon(3)` vs `Poseidon2(t=4)` | 605 | 852 | +40.8% | 137.6 ms | 106.5 ms |
| `Poseidon(4)` vs `Poseidon2(t=8)`\* | 736 | 1,663 | +126.0% | 145.1 ms | 145.7 ms |
| `Poseidon(5)` vs `Poseidon2(t=8)`\* | 835 | 1,663 | +99.2% | 155.1 ms | 151.4 ms |

\*Poseidon2 has no state width t=5 or t=6; both round up to the next defined width, t=8.

Reproduce: `bash circuits/scripts/compile-poseidon-bench.sh` then
`node scripts/bench/poseidon2-delta.mjs --runs 10` (constraints); `--O2` variant via
`bash circuits/scripts/compile-poseidon-bench.sh --O2 --skip-ptau` (see the report for why `--O1`,
matching `compile*.sh`, is the number that actually applies to Veil today).

**Takeaway:** Poseidon2 does not reduce constraints or proving time at the narrow, single-call
arities Veil's circuits actually use — a full protocol migration is not justified by these numbers.
See `docs/research/EXPERIMENTS.md` for the two narrower follow-ups (`--O2` on the production
circuits; Poseidon2 at wide sponge-mode state) this result motivates instead.
