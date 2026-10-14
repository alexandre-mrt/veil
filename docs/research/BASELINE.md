# Veil performance baseline

Measured 2026-07-22 (circuits, proving) and 2026-10-14 (on-chain gas), on one machine. See
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

## On-chain gas (localnet, sui 1.72.1, reference gas price 1000 MIST/unit)

Measured 2026-10-14 by `node scripts/bench/gas-bench.mjs` and `scripts/bench/gas-probe.mjs`; see
[`2026-10-14-onchain-gas-baseline.md`](2026-10-14-onchain-gas-baseline.md). Computation in gas units
(MIST = units × RGP); net = computation + storage − rebate, in MIST.

| Entry point | Computation (units) | Net (MIST) |
|---|---|---|
| publish (6 modules) | 1380 | 152 905 000 |
| `create_pool` | 1000 | 8 518 680 |
| `deposit_and_register` | 1000 | 1 797 468 |
| `update_commitment_root` (propose) | 1000 | 1 328 168 |
| `propose_withdraw_vk` | 1000 | 4 317 400 |
| `shielded_transfer` | 1000 | 2 872 944 |
| `zk_withdraw` | 1000 | 4 451 312 |
| aborted `shielded_transfer` / `zk_withdraw` (bad proof, replay) | 1000 | ≈1 102 000–1 104 000 |

Every entry point except `publish` bills the **1000-unit computation floor**; the work actually done
is below it. Groth16 verification, resolved by in-transaction repetition (units per call):

| Circuit | `prepare_verifying_key` | verify (PVK cached) | prepare + verify (today) |
|---|---|---|---|
| withdraw (5 inputs) | 83.5 | 164.3 | 247.0 |
| compliance (6 inputs) | 83.4 | 173.8 | 257.2 |
| transfer (7 inputs) | 83.4 | 183.4 | 266.6 |

Move test suite (`sui move test`, CLI 1.72.1 — must match the framework rev in `contracts/Move.toml`):
**124 / 124 passed** (2026-10-14).

Reproduce: start a local network (`SUI_CONFIG_DIR=<dir> sui start --force-regenesis --with-faucet`),
compile the circuits, then `node scripts/bench/gas-bench.mjs --sui <path-to-sui-1.72.1>` (≈3 min:
60 s epochs) and `node scripts/bench/gas-probe.mjs --sui <path> --circuit transfer`.

## Known open security finding

`zk_withdraw` does not check the proof's `recipientHash` against its `recipient` argument
(`docs/threat-model.md` E7 — OPEN). Reproduced 2026-10-14.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Gas of `compliant_transfer`, `create_compliance_config`, freeze/multisig/other admin calls | **NOT MEASURED** | Out of scope of the 2026-10-14 run (transfer/withdraw lifecycle only). |
| Gas with a PTB of k transfers; gas vs pool size beyond 2 commitments | **NOT MEASURED** | Needs k valid proofs; queued. |
| Mobile WASM proving latency | **NOT MEASURED** | Browser harness runs desktop headless Chromium only. Cheap extension of `scripts/bench/browser-latency.mjs`. |
| Relayer throughput / leakage under load | **NOT MEASURED** | Queued. |
