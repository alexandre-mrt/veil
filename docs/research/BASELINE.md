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

## Poseidon / Merkle constraint decomposition

Measured 2026-08-17. See
[`2026-08-17-poseidon-merkle-constraint-breakdown.md`](2026-08-17-poseidon-merkle-constraint-breakdown.md).
`transfer.circom`'s 13,611 constraints decompose *exactly* (0 delta) into the sum of its isolated
gadgets:

| Gadget | R1CS constraints | Share of `transfer.circom` |
|---|---|---|
| `MerkleProof(20)` (20x `Poseidon(2)` + `MultiMux1(2)` selectors) | 10,400 | 76.4% |
| 3x `Poseidon(4)` (old/new commitment, nullifier) | 2,208 | 16.2% |
| 1x `Poseidon(3)` (amount hash) | 605 | 4.4% |
| Range-check scaffolding (`GreaterThan`/`Num2Bits`/`LessEqThan`) | 398 | 2.9% |

`compliance.circom` instantiates the same `MerkleProof(20)` template for credential membership; by
inspection those 10,400 constraints are 81.6% of its 12,743 total (not yet exactly reconciled the
way `transfer.circom` was — see open questions in the report).

Reproduce: `node scripts/bench/poseidon-constraint-breakdown.mjs`.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** (still) | 2026-08-17 re-attempt: direct JSON-RPC to a public Sui fullnode is denied by sandbox network policy (`403`, confirmed via the proxy's own status endpoint — a hard policy block, not a transient failure). Building `sui` from source *is* possible here (unlike previously assumed) — `git clone`+`cargo build` both work even though raw `curl` to `github.com`/`crates.io` doesn't — but is multi-hour, not multi-minute; a background build was ~1,140/~unknown crates in after 45 minutes and didn't finish within the session. See [`2026-08-17-poseidon-merkle-constraint-breakdown.md`](2026-08-17-poseidon-merkle-constraint-breakdown.md) for the procedural fix (start the build in the first five minutes of a future session). Top of the queue for the next run. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
