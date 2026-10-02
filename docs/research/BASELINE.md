# Veil performance baseline

Measured 2026-07-22 (circuits, proving) and 2026-10-02 (on-chain gas), on one machine per run. See
[`2026-07-22-baseline-measurement.md`](2026-07-22-baseline-measurement.md) and
[`2026-10-02-onchain-gas-baseline.md`](2026-10-02-onchain-gas-baseline.md) for the full
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

## On-chain gas (2026-10-02, `sui` 1.81.0 localnet, RGP 1000 MIST, real Groth16 proofs)

Reproduce: `node scripts/bench/gas-bench.ts` and `node scripts/bench/gas-probe.ts` (see their headers).
`net = computation + storage − rebate`, MIST. **Every entry point is charged the 1,000-unit computation
floor (1,000,000 MIST)**; user cost is storage-dominated.

| Entry point | Computation (units) | Net MIST |
|---|---|---|
| `publish` (6 modules) | 1,390 | 148,024,400 |
| `create_pool` | 1,000 | 8,518,680 |
| `deposit_and_register` | 1,000 | 1,832,200 |
| `shielded_transfer` | 1,000 | 2,875,376–3,116,144 |
| `shielded_transfer`, invalid proof (abort) | 1,000 | 1,106,856 |
| `compliant_transfer` (2 proofs) | 1,000 | 5,288,528 |
| `zk_withdraw` | 1,000 | 4,453,744 |
| `update_commitment_root` / `propose_withdraw_vk` | 1,000 | 1,362,900 / 4,314,968 |
| `create_compliance_config` | 1,000 | 7,318,868 |
| `freeze_pool` / `unfreeze_pool` | 1,000 | 1,119,700 |

Raw Groth16 cost inside the floor (bucket-inferred, ±5 %, gas units per call): `prepare_verifying_key`
≈ 82; `verify_groth16_proof` (VK prepared) ≈ 164–183 (5–7 inputs); prepare + verify (today's
`verifier.move`) ≈ 235–270. A pre-prepared VK would save ≈ 82 units but **0 MIST today** (hidden by the floor).

Caveats: localnet, not live network (re-check RGP/storage price); single validator (no contention data).
Proving-time rows above predate a switch to a locally generated pot15 — not re-measured.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Shared-object (`Pool`) contention under concurrent transfers | **NOT MEASURED** | Needs concurrent submission; single-validator localnet shows execution cost only. |
| Gas on a live network (testnet/mainnet RGP + storage price) | **NOT MEASURED** | `fullnode.testnet.sui.io` is blocked by the sandbox egress policy; localnet used instead. |
| Mobile WASM proving latency | **NOT MEASURED** | Desktop headless Chromium only so far; extend `scripts/bench/browser-latency.mjs` with a mobile emulation profile. |
| Relayer throughput / leakage under load | **NOT MEASURED** | Queued. |

Known-open security finding affecting the numbers' meaning: `zk_withdraw` does not bind the proof to
`recipient` (F1 in the 2026-10-02 report) — any fix adds on-chain hashing cost that must be re-measured here.
