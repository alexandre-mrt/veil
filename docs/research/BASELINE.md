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

## On-chain gas per entry point (measured 2026-11-17)

Real transactions on a local Sui network (`sui 1.84.0-9dc25070cf2e`, built from source at tag
`testnet-v1.84.0`; `sui start --with-faucet --force-regenesis`), reference gas price 1,000 MIST/unit,
real Groth16 proofs from the three circuits. 3 rounds on 3 independent pools; every value below was
**identical in all 3 rounds** (Sui gas is deterministic for equal inputs). Full writeup and raw
output: [`2026-11-17-onchain-gas-baseline.md`](2026-11-17-onchain-gas-baseline.md).

| Entry point | Computation (MIST) | Storage (MIST) | Rebate (MIST) | **Net (MIST)** |
|---|---|---|---|---|
| `pool::shielded_transfer` (1 Groth16 verify) | 1,000,000 | 14,485,600 | 12,736,326 | **2,749,274** |
| `compliance::compliant_transfer` (2 Groth16 verifies) | 1,000,000 | 22,556,800 | 18,450,955 | **5,105,845** |
| `pool::zk_withdraw` (1 verify, coin out + change note) | 1,000,000 | 15,823,200 | 12,493,151 | **4,330,049** |
| `pool::deposit_and_register` | 1,000,000 | 10,358,800 | 8,305,969 | **3,052,831** |
| rejected: replayed `shielded_transfer` (abort 9) | 1,000,000 | 10,442,400 | 10,441,356 | **1,001,044** |
| rejected: `zk_withdraw` with mismatched inputs (abort 28, after full pairing check) | 1,000,000 | 10,442,400 | 10,441,356 | **1,001,044** |
| `pool::create_pool` | 1,000,000 | 8,496,800 | 987,901 | **8,508,899** |
| `compliance::create_compliance_config` | 1,000,000 | 18,171,600 | 11,968,803 | **7,202,797** |
| `pool::update_commitment_root` | 1,000,000 | 8,740,000 | 8,495,950 | **1,244,050** |
| `pool::propose_withdraw_vk` | 1,000,000 | 11,970,000 | 8,739,126 | **4,230,874** |
| `pool::propose_vk_update` | 1,000,000 | 15,686,400 | 11,968,803 | **4,717,597** |
| `pool::freeze_pool` / `unfreeze_pool` | 1,000,000 | 11,970,000 | 11,968,803 | **1,001,197** |
| package publish (6 modules) | 1,410,000 | 156,415,600 | 19,758,024 | **138,067,576** |

Every call, including `compliant_transfer` with two BN254 pairing checks, lands in Sui's **minimum
computation bucket (1,000 units)**. What Veil actually pays per call is set by storage — rewriting
the `Pool` object (which carries the raw VK bytes and all pending-update fields) plus the new
dynamic fields — not by proof verification. Net MIST scales with the reference gas price; the
storage figures are protocol-config-dependent (localnet runs the latest protocol version, not
necessarily what testnet/mainnet run on a given day).

Reproduce: `bun run scripts/bench/gas-localnet.ts --rounds 3` against a running localnet.

## Not yet measured

| Metric | Status | Why |
|---|---|---|
| Gas on testnet/mainnet protocol config | **NOT MEASURED** | Public fullnodes (`fullnode.testnet.sui.io`) are denied by this sandbox's egress policy (HTTP 403 on CONNECT, 2026-11-17). Localnet numbers above are real but use localnet's protocol version and RGP. |
| Mobile WASM proving latency | **NOT MEASURED** | Tonight's browser harness runs desktop headless Chromium only. Extending it to a mobile Chromium device emulation profile is a natural, cheap follow-up (same harness, `page.emulate` a device descriptor). |
| Relayer throughput / leakage under load | **NOT MEASURED** | Out of scope for tonight; queued. |

Move test suite: `sui move test` → 124/124 passed (2026-11-17, sui 1.84.0). Whatever comes out of a future run should replace the corresponding row above in
place, not be appended as a separate table.
