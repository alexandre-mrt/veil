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

## Where the non-linear constraints actually come from

Measured 2026-09-27 (see
[`2026-09-27-poseidon-constraint-attribution.md`](2026-09-27-poseidon-constraint-attribution.md)).
Each row's cost was isolated in its own single-gadget probe circuit
(`scripts/bench/circuit-probes/*.circom`), then multiplied by how many times the real circuit
instantiates it; the sum reconciles to the real compiled total exactly for `transfer`/`withdraw` and
to within 3 constraints (fully explained — two defense-in-depth boolean checks plus one AND gate,
not present in the isolated comparator probes) for `compliance`.

| Circuit | Merkle path (20×`Poseidon(2)`) | Named domain-tagged Poseidon calls | Range checks + comparators (+ glue) | Total non-linear |
|---|---|---|---|---|
| `transfer.circom` | 4,920 (**76.0%**) | 1,164 (18.0%) | 386 (6.0%) | 6,470 |
| `compliance.circom` | 4,920 (**81.2%**) | 852 (14.1%) | 282 + 3 glue (4.7%) | 6,057 |
| `withdraw.circom` (no Merkle path) | — | 1,143 (**78.0%**) | 322 (22.0%) | 1,465 |

**Correction to the README's "four Poseidon instances... dominate the real cost" claim:** true for
`withdraw.circom` (no Merkle path — the named Poseidon calls really are the dominant cost there),
but materially understates the real driver for `transfer.circom` and `compliance.circom`, where the
depth-20 Merkle membership proof — not the four/five named domain-tagged hashes — is responsible for
76–81% of non-linear constraints. Per-Merkle-level cost is exactly 246 non-linear constraints (243
for `Poseidon(2)` + 2 for `MultiMux1(2)`'s selection + 1 for the boolean path-index check),
architecture-fixed regardless of depth. This re-targets `EXPERIMENTS.md` items #2 (Poseidon2 should
aim at the arity-2 Merkle hash first, not the named calls) and #4 (Merkle-depth-vs-anonymity-set
trade-off now has a real per-level cost to compute against, e.g. depth 20→32 costs +2,952 non-linear
constraints to `transfer.circom` alone).

Reproduce: `cd scripts/bench && npm install && node constraint-attribution.mjs`.

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
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** (confirmed a 3rd time, 2026-09-27) | Both fallback paths retested tonight and both return a 403 from the sandbox's egress proxy — an organization-level allowlist denial, not a per-tool approval prompt: `github.com` (needed for a `sui` CLI release) and `fullnode.testnet.sui.io` (direct JSON-RPC read) are both unreachable hosts. Per the sandbox's own proxy documentation, a 403 is not retried or routed around. Unblocking this needs either host added to the sandbox's egress allowlist. Still top of the queue. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Circuit tests in real-proof mode (108 tests) | **NOT RUN 2026-09-27** (new blocker) | `storage.googleapis.com` (where `compile*.sh` downloads the pot15 Powers of Tau file) also returns a 403 from the sandbox's egress proxy — confirmed with a HEAD request tonight. Tests ran in fallback/simulated mode instead (108/108 pass — see 2026-09-27 report), which the README itself calls "a linting aid, not evidence." No production circuit changed tonight, so risk is low, but this is a second host (beyond `github.com` and the Sui RPC host) that would need allowlisting to restore real-proof-mode testing in this sandbox. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
