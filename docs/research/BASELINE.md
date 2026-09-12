# Veil performance baseline

Constraint counts below reflect `circuits/scripts/compile*.sh` as of 2026-09-12 (`circom --O2`,
full constraint simplification — see `2026-09-12-ci-backlog-and-O2-optimization.md`). Proving
time, zkey, and vk size are still the 2026-07-22 **`--O1` (circom's then-default)** measurements —
see the `--O2 pending re-measurement` note below each table before citing them. See
[`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md) for the original
methodology and raw command output. Superseded rows should be replaced in place with a note in
`LEDGER.md` pointing at the experiment that changed them — this file always reflects the current
state of the protocol, not history.

Toolchain: circom 2.2.2 (built from source, `iden3/circom` tag `v2.2.2`), snarkjs 0.7.6, Node
v22.22.2, Chromium 141 (headless, via Playwright), pot15 Powers of Tau (Hermez, `2^15` — reused
for all three circuits per the existing `compile*.sh` scripts), single dev-only Groth16
contribution (matches `circuits/scripts/compile*.sh` — **not** a production ceremony; see
`ceremony.sh` and `docs/threat-model.md` RR2).

## Constraint counts (circom `--O2`, current)

| Circuit | R1CS constraints | Non-linear | Linear | Wires | Public / private inputs |
|---|---|---|---|---|---|
| `transfer.circom` | 6,384 | 6,384 | 0 | 6,407 | 7 / 47 |
| `compliance.circom` | 5,979 | 5,979 | 0 | 5,998 | 6 / 45 |
| `withdraw.circom` | 1,439 | 1,439 | 0 | 1,441 | 5 / 5 |

Measured 2026-09-12: `circom {transfer,compliance,withdraw}.circom --O2 --r1cs -o <dir> -l
node_modules` + `npx snarkjs r1cs info <dir>/<circuit>.r1cs`. circom's default
before this change was `--O1` (signal-to-signal/signal-to-constant simplification only); `--O2`
(full constraint simplification) was sitting correctly diagnosed but unmerged since PR #24/#40
(2026-08-04/2026-08-22, both still open) — see the 2026-09-12 report for why it took this long to
land. **-53.1% / -53.1% / -52.9%** vs. the previous `--O1` baseline (13,611 / 12,743 / 3,058) —
functionally verified equivalent (same accept/reject behavior on both a valid and a deliberately
malformed witness, see report), not just smaller.

**Not yet re-measured at `--O2`:** zkey/vk size, proving time (Node + browser), on-chain proof
bytes (should be unchanged — Groth16 proofs are always 3 group elements regardless of constraint
count, but not re-confirmed against an `--O2` zkey). Needs a fresh Groth16 setup, which this
session's sandbox could not complete within budget (see report, "Toolchain gaps") — the numbers
below are the **historical `--O1` measurements**, kept for reference, not representative of the
circuits `compile*.sh` now produces.

### `--O1` (historical, 2026-07-22 — see above before citing)

| Circuit | R1CS constraints | Non-linear | Linear | Wires | Public / private inputs | zkey (bytes) | vk (bytes) | Compressed on-chain proof (bytes) |
|---|---|---|---|---|---|---|---|---|
| `transfer.circom` | 13,611 | 6,470 | 7,141 | 13,632 | 7 / 47 | 6,001,431 | 4,025 | 128 |
| `compliance.circom` | 12,743 | 6,057 | 6,686 | 12,762 | 6 / 45 | 5,682,155 | 3,841 | 128 |
| `withdraw.circom` | 3,058 | 1,465 | 1,593 | 3,058 | 5 / 5 | 1,385,335 | 3,656 | 128 |

Groth16 proofs are three fixed-size group elements (2×G1 + 1×G2) regardless of circuit — the
128-byte compressed on-chain figure (from `scripts/src/test-converter.ts`, `proofToSuiBytes`) is
constant across all three circuits. snarkjs's own JSON proof encoding (decimal-string field
elements) runs ~721–726 bytes for the same data. This paragraph is expected to still hold under
`--O2` (proof size depends only on the proof system, not the R1CS) but is not yet re-confirmed.

## Proving time (mean of 10 runs, includes witness generation) — **`--O1`, historical, pending `--O2` re-measurement**

| Circuit | Node.js (this machine) | Chromium (headless, this machine) | Browser / Node ratio |
|---|---|---|---|
| `transfer.circom` | 751.9 ms (σ 17.3) | 1213.3 ms (σ 32.6, 8 runs) | 1.61x |
| `compliance.circom` | 738.1 ms (σ 20.9) | 1163.4 ms (σ 58.6, 8 runs) | 1.58x |
| `withdraw.circom` | 244.3 ms (σ 7.9) | 382.9 ms (σ 9.9, 8 runs) | 1.57x |

Reproduce: `node scripts/bench/prove-latency.mjs --runs 10` and
`node scripts/bench/browser-latency.mjs --runs 8` (see that directory for prerequisites — will
need a fresh `--O2` zkey per circuit; the script itself doesn't care which optimization level
produced its inputs).

**Deployment note:** the live testnet package's verifying keys were built from `--O1`-compiled
circuits (the default `compile*.sh` used until this change). Switching the default to `--O2`
changes the R1CS and therefore the zkey/vk for any *future* compile — it does not retroactively
touch the already-deployed pool. Landing this for real requires a fresh Groth16 ceremony against
the `--O2` circuits and going through the existing `propose_vk_update` + 1-epoch-timelock flow
(`docs/threat-model.md` T3) before the live pool would accept `--O2`-proved transactions — not
attempted this session (same zkey-setup budget constraint as above).

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** | No `sui` CLI binary available or installable in this session (no prebuilt binary reachable, building the full Sui workspace from source was judged impractical within a single night's budget), and ad-hoc JSON-RPC calls to a public Sui endpoint were not attempted after an early network-call permission denial in the same session (see the experiment report). Top of the queue for the next run. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
