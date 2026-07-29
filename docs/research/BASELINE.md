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

## Poseidon2 Merkle-hashing candidate (validated 2026-07-29, not yet in production)

**The tables above are still the deployed protocol's real numbers — nothing below has been cut into
`transfer.circom`/`compliance.circom` yet.** See
[`2026-07-29-poseidon2-merkle-hashing.md`](2026-07-29-poseidon2-merkle-hashing.md) for the full
experiment: swapping only the repeated 20-level Merkle-tree pairwise hash from circomlib's
`Poseidon(2)` to Poseidon2 in compression mode (`@taceo/circom-lib`, T=2, no capacity element) —
commitment/nullifier/leaf hashes stay unchanged circomlib Poseidon — measures as a real, modest win.
A naive "replace every Poseidon call" design was also measured and is a net loss (see the report);
do not extend this beyond the Merkle tree.

| Circuit | R1CS constraints | Non-linear | Linear | Wires | zkey (bytes) | Node proving time (mean of 10, same session as baseline) |
|---|---|---|---|---|---|---|
| `transfer_hybrid.circom` | 13,611 → 12,951 (−4.85%) | 6,470 → 5,930 | 7,141 → 7,021 | 13,632 → 12,972 | 6,001,422 → 5,742,712 | 922.46ms → 881.65ms (−4.4%) |
| `compliance_hybrid.circom` | 12,743 → 12,083 (−5.18%) | 6,057 → 5,517 | 6,686 → 6,566 | 12,762 → 12,102 | 5,682,146 → 5,423,436 | 879.89ms → 847.68ms (−3.7%) |

Reference circuits: `circuits/transfer_hybrid.circom`, `circuits/compliance_hybrid.circom`,
`circuits/templates/merkle_proof_poseidon2.circom`, `circuits/templates/poseidon2_compat.circom`.
Reproduce: `node scripts/bench/prove-latency-poseidon2.mjs --runs 10` (see `circuits/scripts/` and
the report's Approach section for the compile + trusted-setup commands). Soundness:
`node --experimental-vm-modules circuits/test/poseidon2_hybrid.test.mjs`.

Cutting this into production is queue item #2 in `EXPERIMENTS.md` — it needs a VK regeneration and
redeployment through the existing timelocked update path, not just a circuit-file edit.
