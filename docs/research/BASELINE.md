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

## On-chain gas per entry point (localnet, real transactions, real proofs)

Measured 2026-11-18 ([`2026-11-18-onchain-gas-baseline.md`](2026-11-18-onchain-gas-baseline.md)).
`sui` 1.72.1 built from source at the exact framework rev `contracts/Move.lock` pins
(`94ad8ccd`), `sui start --with-faucet --force-regenesis`, protocol version 124, reference gas
price 1,000 MIST/unit, storage price 76 (→ 7,600 MIST per stored byte), 99% storage rebate.
Every row is `effects.gasUsed` from an executed transaction; three full runs produced
byte-identical gas for every row. Reproduce: `scripts/bench/gas-localnet.ts` (header has the
exact commands).

| Entry point | Computation (MIST) | Storage cost | Storage rebate | **Net paid (MIST)** |
|---|---|---|---|---|
| `deposit_and_register` | 1,000,000 | 10,358,800 | 8,223,732 | **3,135,068** |
| `shielded_transfer` (1 Groth16 verify) | 1,000,000 | 14,485,600 | 12,610,224 | **2,875,376** |
| `zk_withdraw` (1 Groth16 verify) | 1,000,000 | 15,823,200 | 12,369,456 | **4,453,744** |
| `compliance::compliant_transfer` (2 Groth16 verifies) | 1,000,000 | 22,556,800 | 18,268,272 | **5,288,528** |
| replayed `shielded_transfer` (aborts, code 9, *after* verify) | 1,000,000 | 10,442,400 | 10,337,976 | 1,104,424 |
| `create_pool` | 1,000,000 | 8,496,800 | 978,120 | 8,518,680 |
| `compliance::create_compliance_config` | 1,000,000 | 18,171,600 | 11,850,300 | 7,321,300 |
| `update_commitment_root` | 1,000,000 | 8,740,000 | 8,411,832 | 1,328,168 |
| `propose_withdraw_vk` | 1,000,000 | 11,970,000 | 8,652,600 | 4,317,400 |
| `propose_vk_update` / `cancel_vk_update` | 1,000,000 / 1,000,000 | 15,929,600 / 12,213,200 | 12,091,068 / 15,770,304 | 4,838,532 / −2,557,104 |
| `freeze_pool` / `unfreeze_pool` | 1,000,000 | 12,213,200 | 12,091,068 | 1,122,132 |
| package publish | 1,380,000 | 156,415,600 | 4,890,600 | 152,905,000 |

**Every user-facing entry point sits on the 1,000-unit computation floor** (`base_tx_cost_fixed`
= 1,000). The Groth16 work is real but smaller than the floor:

| `0x2::groth16` op (transfer VK, 7 public inputs) | Per-op computation, units (slope k=50→100 in one PTB) | Protocol-config internal gas |
|---|---|---|
| `prepare_verifying_key` | 84.2 | 82,010 |
| parse proof + inputs + `verify_groth16_proof` (PVK reused) | 189.4 | 115,502 + 7 × 9,484 = 181,890 |
| full prepare + verify (what `verifier.move` does today) | 278.0 | — |

Storage, not computation, is what a transfer pays for: the ~1,477-byte shared `Pool` object ((12,213,200 − 988,000 gas-coin rewrite) / 7,600 MIST per byte)
(both VKs stored inline) is rewritten on every call (12.2M MIST gross, 99% rebated), and each
transfer adds nullifier/commitment dynamic fields that are never deleted.

## Other axes — status

| Metric | Status | Why |
|---|---|---|
| Move contract test suite | **PASS 124/124** (2026-11-18) | `sui move test` with the from-source `sui` 1.72.1 — first time this loop has run it. |
| Gas on testnet/mainnet protocol versions | **NOT MEASURED** | The numbers above are protocol 124 (localnet from the pinned rev). Live networks may run a different protocol version with different native costs; the public fullnode was unreachable from this sandbox (egress denied). |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Superseded rows above should be replaced in place, not appended as a separate table.
