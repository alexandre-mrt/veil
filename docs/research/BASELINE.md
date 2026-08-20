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
`ceremony.sh` and `docs/threat-model.md` RR2). The gadget-attribution numbers below (2026-08-20)
were compiled with `circom2` 0.2.23 (circom compiler 2.2.3, installed via `circuits/`'s
`devDependencies` from npm) instead — verified byte-identical to the native 2.2.2 build on
`transfer.circom` before being trusted for anything (see that report's "attempt #1").

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

## Non-linear constraint attribution (per gadget)

Where the constraint counts above actually come from, measured by compiling each gadget alone
(2026-08-20). See
[`2026-08-20-poseidon-constraint-attribution.md`](2026-08-20-poseidon-constraint-attribution.md)
for the full reconciliation and the derivation of why this rules out a same-arity Poseidon2 swap
as a constraint-count win.

| Gadget | Non-linear constraints |
|---|---|
| `Poseidon(2)` | 243 |
| `Poseidon(3)` | 264 |
| `Poseidon(4)` | 300 |
| `Poseidon(5)` | 324 |
| `Num2Bits(8)` | 8 |
| `Num2Bits(64)` | 64 |
| `GreaterThan(64)` | 65 |
| `GreaterEqThan(8)` | 9 |
| `GreaterEqThan(64)` | 65 |
| `LessEqThan(64)` | 65 |
| `MerkleProof(20)` (20x `Poseidon(2)` + 20x `MultiMux1(2)` + 20 bit checks) | 4,920 (243/level) |

Poseidon calls (including inside `MerkleProof`) account for 93.1% of `transfer.circom`'s and 94.3%
of `compliance.circom`'s non-linear constraints; the Merkle membership proof alone is 75–80% of
each. `withdraw.circom` has no Merkle proof and is 78.0% Poseidon.

Reproduce: `bash scripts/bench/constraint-attribution.sh`.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** (confirmed structural, 2026-08-20) | No `sui` CLI binary, and every path this session found to get one — `fullnode.testnet.sui.io` RPC, `github.com` release binaries, `crates.io`'s API and binary CDN — returns `403` from the sandbox's egress proxy, which its own diagnostics identify as an organization policy denial, not a transient failure. See the 2026-08-20 report's "On-chain gas, attempt #2" section for the raw output. Needs a policy exception or a `sui` binary preinstalled in the sandbox image; not worth another night's budget on the network side alone. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
