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

## Constraint breakdown: Poseidon vs everything else (2026-09-25)

Isolating each circuit's Poseidon instances (see
[`2026-09-25-poseidon-merkle-constraint-isolation.md`](2026-09-25-poseidon-merkle-constraint-isolation.md))
shows Poseidon — specifically the depth-20 `MerkleProof` component — dominates non-linear
constraint count:

| Circuit | Poseidon share of non-linear constraints | Of which `MerkleProof(20)` alone |
|---|---|---|
| `transfer.circom` | 94.0% | 76.0% (4,920 / 6,470) |
| `withdraw.circom` | 78.0% | n/a (no Merkle proof — commitment is revealed on-chain by design) |
| `compliance.circom` | 95.3% | 81.2% (4,920 / 6,057) |

Per-Merkle-level cost: **246 non-linear constraints/level** (243 from `Poseidon(2)`, 3 from the
`MultiMux1(2)` path selector). Reproduce: `cd scripts/bench && npm install && node
poseidon-isolation.mjs`.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** | No `sui` CLI binary reachable, and every public Sui RPC/explorer host tried is denied by this sandbox's egress policy (organization-policy `403`, confirmed non-retryable — see 2026-09-25 report). Not unblockable from inside the loop; needs a policy or artifact-delivery change. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed since 2026-07-22; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Real-Groth16 circuit test suite (108 tests, `transfer`/`withdraw`/`compliance`) | **HASH-ONLY** as of 2026-09-25 | Needs a compiled zkey from a Groth16 trusted setup, which needs the Hermez Powers-of-Tau file at `storage.googleapis.com` — also now blocked by the same egress policy (worked on 2026-07-22, does not tonight). A from-scratch local `snarkjs powersoftau` ceremony (no network needed) is untried and queued. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

**Toolchain note (2026-09-25):** the native `circom` build (via `cargo install`/`cargo build` from
`iden3/circom`) that produced the constraint counts above is no longer reproducible in this
sandbox — `github.com` and `static.crates.io` are now blocked. **`circom2`** (npm, circom 2.2.3
compiled to WASM) is a verified drop-in replacement: recompiling `transfer.circom` with it
reproduces this file's constraint counts exactly. Prefer it for any future night that needs to
compile circuits here.

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
