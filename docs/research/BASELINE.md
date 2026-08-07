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

## Non-linear constraint attribution

Measured 2026-08-07. Each circuit's non-linear R1CS constraints, decomposed by gadget (isolated
compile of each `circomlib`/local template, instance counts re-derived from source, summed and
diffed against the real compiled circuit). See
[`2026-08-07-poseidon-constraint-attribution.md`](2026-08-07-poseidon-constraint-attribution.md)
for the full method, raw output, and why this ran instead of a literal Poseidon2 swap.

| Circuit | Total non-linear | Merkle path (depth 20) | Poseidon (all arities, incl. Merkle) | Num2Bits | Comparators | Attribution coverage |
|---|---|---|---|---|---|---|
| `transfer.circom` | 6,470 | 4,920 (76.0%) | 6,024 (93.1%) | 256 (4.0%) | 130 (2.0%) | 99.99% |
| `compliance.circom` | 6,057 | 4,920 (81.2%) | 5,712 (94.3%) | 208 (3.4%) | 74 (1.2%) | 99.95% |
| `withdraw.circom` | 1,465 | — (no Merkle path) | 1,143 (78.0%) | 192 (13.1%) | 130 (8.9%) | 100.00% |

The depth-20 Merkle-membership check alone — 20 `Poseidon(2)` calls — is 75–80% of the entire
non-linear cost of both circuits that carry one, more than every "identity" Poseidon call
(commitment, nullifier, credential leaf, context) combined. Reproduce:
`node scripts/bench/gadget-attribution/measure.mjs` (needs `circom` on `PATH` or `CIRCOM_BIN` set).

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
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** | Re-attempted 2026-08-07: network is no longer the blocker (`git clone`/`cargo install` of `MystenLabs/sui` both work from this sandbox), but a full `sui` CLI build is compute-bound — 4 vCPUs, still mid-compile after 15 minutes with hundreds of crates left, a multi-hour job. Even a built CLI can't reach `fullnode.testnet.sui.io` (still network-blocked) — the real path is a fully local `sui start` network, gated on the same build. See the 2026-08-07 report's Toolchain note. Top of the queue for the next run, budgeted as a dedicated multi-hour (or background-across-a-night) build. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
