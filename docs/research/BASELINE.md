# Veil performance baseline

Measured 2026-07-22, on one machine, in one run (mobile-approximated row added 2026-09-28). See
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

## Mobile WASM proving latency (approximated, 2026-09-28)

**UNMEASURED on real hardware — see caveat.** `scripts/bench/browser-latency.mjs --device "Pixel 7"
--cpu-throttle 4` runs the same headless-Chromium harness as the desktop numbers above, but with a
Playwright device descriptor (viewport/UA/DPR) and a 4x CDP CPU throttle (Lighthouse's standard
"mid-tier mobile" multiplier) applied. This still runs on the host machine's desktop x86_64 CPU — it
approximates a mid/high-tier Android phone's CPU budget, it is **not** a measurement on real mobile
hardware (no real ARM silicon, mobile WASM JIT, or thermal throttling). Full methodology and caveats:
[`2026-09-28-mobile-wasm-proving-latency.md`](2026-09-28-mobile-wasm-proving-latency.md).

| Circuit | Desktop headless (ms) | Mobile-approximated, 4x throttle (ms) | Ratio |
|---|---|---|---|
| `transfer.circom` | 1228.03 | 2335.45 | 1.90x |
| `compliance.circom` | 1193.95 | 2327.08 | 1.95x |
| `withdraw.circom` | 385.96 | 897.97 | 2.33x |

Reproduce: `node scripts/bench/browser-latency.mjs --runs 8 --device "Pixel 7" --cpu-throttle 4`.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** (3rd attempt, 2026-09-28) | No `sui` CLI reachable (not on crates.io, and `github.com/MystenLabs/sui/releases` + Sui/Aptos RPC/CDN hosts all denied — confirmed as explicit egress-policy denials via the agent proxy's own status endpoint, not a transient fault). This is now an infrastructure allowlist/vendoring problem, not something an in-session retry can fix. Top of the queue for the next run, pending an environment change. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Poseidon2 vs current Poseidon | **NOT MEASURED** | No circom-level Poseidon2 template exists on npm (only JS/TS hashers), and no reference implementation or test vectors were reachable to verify a from-scratch round-constant derivation against (same network restrictions as above). PARKed — see queue. |
| Real mobile hardware proving latency | **NOT MEASURED** | The row above is a CPU-throttled desktop approximation, not a real device. A real-device provider was not attempted this session (assumed blocked by the same egress policy; not yet confirmed). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
