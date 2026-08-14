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

## Non-linear constraint decomposition (per gadget)

Measured 2026-08-14, same toolchain (circom 2.2.2, source-built; circomlib 2.0.5). See
[`2026-08-14-poseidon-constraint-decomposition.md`](2026-08-14-poseidon-constraint-decomposition.md)
for the full methodology and raw output. Every non-linear constraint below reconstructs the actual
totals above **exactly** (delta 0 for all three circuits) — this is a verified decomposition, not an
estimate.

| Circuit | Merkle accumulator (depth 20) | Domain-tag Poseidon hashes | Range checks / comparators |
|---|---|---|---|
| `transfer.circom` | 4,920 (76.0%) | 1,164 (18.0%) | 386 (6.0%) |
| `compliance.circom` | 4,920 (81.2%) | 852 (14.1%) | 285 (4.7%) |
| `withdraw.circom` (no Merkle tree) | — | 1,143 (78.0%) | 322 (22.0%) |

Per-gadget non-linear/linear constraint costs (isolated single-instance compilation):

| Gadget | Non-linear | Linear |
|---|---|---|
| `Poseidon(2)` | 243 | 274 |
| `Poseidon(3)` | 264 | 341 |
| `Poseidon(4)` | 300 | 436 |
| `Poseidon(5)` | 324 | 511 |
| `Num2Bits(64)` | 64 | 1 |
| `Num2Bits(8)` | 8 | 1 |
| `LessEqThan(64)` / `GreaterThan(64)` / `GreaterEqThan(64)` | 65 | 3–4 |
| `GreaterEqThan(8)` | 9 | 4 |
| `MultiMux1(2)` | 2 | 0 |
| One Merkle tree level (`Poseidon(2)` + `MultiMux1(2)` + boolean check) | 246 | 274 |

Reproduce: `node scripts/bench/poseidon-constraint-decomposition.mjs` (needs a `circom` binary on
`PATH` or `$CIRCOM_BIN`).

**Headline correction to the "four Poseidon instances dominate" framing above:** three-quarters to
four-fifths of that Poseidon cost in `transfer.circom`/`compliance.circom` is the depth-20 Merkle
authentication path (20 identical `Poseidon(2)` calls), not the domain-tagged
commitment/nullifier/credential hashes. Any future prover-time optimization (Poseidon2, shallower
tree, etc.) should be sized against that split, not against "Poseidon" as an undifferentiated whole.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| On-chain gas per entry point (`deposit`, `shielded_transfer`, `zk_withdraw`, compliance verify, admin ops) | **BLOCKED** (retried 2026-08-14, confirmed for two independent, non-retryable reasons) | Direct JSON-RPC to a public Sui testnet fullnode is denied by the session's egress proxy policy (403 on CONNECT, confirmed via the proxy's own status endpoint — not a transient failure). Building/fetching the `sui` CLI needs the `MystenLabs/sui` GitHub repo, which is out of this session's repo scope (`alexandre-mrt/veil` only) and returns an explicit access-not-enabled error, not a network error. Neither is fixable by retrying; see the 2026-08-14 report's Open Questions for what unblocking actually requires. Still top of the queue. |
| Move contract test suite (124 tests, `sui move test`) | **NOT RUN** (same blocker) | No contract code changed this session; risk from skipping is low but this is a real verification gap, not a passing claim. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Whatever comes out of a future gas/Move-test run should replace the corresponding row above in
place, not be appended as a separate table.
