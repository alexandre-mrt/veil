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

## Constraint attribution: hashing vs. everything else

Measured 2026-07-31, same toolchain as above. See
[`2026-07-31-hash-constraint-attribution.md`](2026-07-31-hash-constraint-attribution.md) for
methodology and raw output. Reproduce: `node scripts/bench/hash-constraint-attribution.mjs`.

| Circuit | Poseidon instances | Merkle depth | Non-linear (actual) | Attributed to hashing | Hash % (non-linear / linear) |
|---|---|---|---|---|---|
| `transfer.circom` | 3×`Poseidon(4)` + 1×`Poseidon(3)` | 20 | 6,470 | 6,084 | 94.0% / 99.8% |
| `compliance.circom` | 1×`Poseidon(5)` + 2×`Poseidon(3)` | 20 | 6,057 | 5,772 | 95.3% / 99.8% |
| `withdraw.circom` | 3×`Poseidon(4)` + 1×`Poseidon(2)` | — | 1,465 | 1,143 | 78.0% / 99.3% |

Per-primitive cost (isolated micro-circuits, same circom build): `Poseidon(2)` = 243 non-linear /
274 linear, `Poseidon(3)` = 264 / 341, `Poseidon(4)` = 300 / 436, `Poseidon(5)` = 324 / 511,
depth-20 `MerkleProof` (the real `templates/merkle_proof.circom`) = 4,920 / 5,480 — i.e. **246
non-linear / 274 linear constraints per Merkle level**. The depth-20 Merkle path alone outweighs
all of a circuit's identity/nullifier Poseidon calls combined (4.2× in `transfer.circom`, 5.8× in
`compliance.circom`). Non-hash circuit logic (range checks, comparators, threshold/epoch
enforcement) is 11–13 linear constraints per circuit — a rounding error against the totals above.

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
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** | Re-attempted 2026-07-31: no `sui` CLI binary reachable (no prebuilt release asset — `api.github.com` returns `403` at this session's network proxy — and `sui` is not a real published crate on crates.io, only a name-squatted unrelated package), and a direct JSON-RPC read against a public Sui fullnode is blocked by the same proxy policy (`403` on `CONNECT`). This is a session/environment network-egress policy limit, not a local toolchain gap — see [`2026-07-31-hash-constraint-attribution.md`](2026-07-31-hash-constraint-attribution.md) for the exact commands and responses. Not autonomously fixable by re-attempting; needs the environment's network policy widened or a `sui` binary provisioned another way. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
