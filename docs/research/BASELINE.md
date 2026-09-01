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

## Poseidon constraint breakdown

Measured 2026-09-01 as a byproduct of the Poseidon2 constraint-delta experiment
([`2026-09-01-poseidon2-constraint-delta.md`](2026-09-01-poseidon2-constraint-delta.md))
— included here because it decomposes the constraint counts above (doesn't
change them) and answers 2026-07-22's own open question about where
`transfer`/`compliance`'s non-linear constraints actually come from. Verdict
on that night's Poseidon2 swap itself was **REJECT**; this breakdown stands
independent of that verdict, it's a fact about the current, unchanged
circuits.

| Circuit | Total non-linear | Poseidon-instance-attributable | Everything else (range checks, comparators, Merkle-path muxes) |
|---|---|---|---|
| `transfer.circom` | 6,470 | 6,024 — **93.1%** | 446 — 6.9% |
| `compliance.circom` | 6,057 | 5,712 — **94.3%** | 345 — 5.7% |
| `withdraw.circom` | 1,465 | 1,143 — **78.0%** | 322 — 22.0% |

The depth-20 `MerkleProof` path alone (20 × `Poseidon(2)`, 243 non-linear
constraints each = 4,860) is **75.1%** of `transfer`'s and **80.2%** of
`compliance`'s total non-linear constraints by itself — the single biggest
lever in either circuit. `withdraw.circom` has no Merkle proof, hence its
lower Poseidon share.

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
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** (3rd time, 2026-09-01) | No `sui` CLI installable: no prebuilt binary reachable, and `crates.io`'s `sui`/`sui-sdk` crates are unrelated name-squatted placeholders (0 deps, v0.0.1/v0.0.0), not the Mysten Labs CLI. The JSON-RPC fallback against the deployed testnet package is a confirmed hard organizational egress-policy block (proxy 403 to `fullnode.testnet.sui.io:443`), not transient. Re-ranked down in `EXPERIMENTS.md` — needs either a multi-night from-source Sui build or a policy change, not another single-night unblock attempt. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
