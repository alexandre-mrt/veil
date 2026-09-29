# 2026-09-29 — On-chain gas per entry point (queue item #1)

## Hypothesis

Veil's on-chain cost per entry point can be measured for real — every `pool`/`compliance` entry
point driven with real Groth16 proofs on a real Sui execution engine — and doing so will show whether
Groth16 verification (the thing aggregation/batching would optimise) or something else dominates the
bill. Falsifiable claim being tested: *"proof verification is the dominant on-chain cost of a private
transfer."* Number it moves: **gas per entry point, from "unmeasured" (2026-07-22 BASELINE) to 17
measured rows**, plus the split computation vs. storage.

This is a measurement night. No circuit, Move source or frontend code changed.

## Threat / privacy model

No protocol change → no adversary model change. The relevant question is who is hurt by *not* having
these numbers:

- **Griefing / DoS analysis** (`docs/threat-model.md`, STRIDE *Denial of service*): a rational attacker's
  cost to spam the shared `Pool` object is exactly the per-tx gas measured here. Before tonight that
  cost was a guess.
- **Statistical deanonymiser / relayer economics** (I3 in the threat model): the relayer pays gas for
  users. Its per-transfer cost bounds how many sponsored transfers it can afford under load, which is
  what limits the anonymity-set growth rate the relayer can subsidise.

What this does **not** establish: mainnet/testnet prices (see Assumptions), throughput or shared-object
contention (one sequential sender only), or anything about soundness/privacy. Residual surface is
unchanged.

Assumptions: measured on a **local** network (`sui start --force-regenesis`, protocol version 137, Sui CLI
1.80.1), reference gas price 1000 MIST/unit, default genesis storage price. Gas *units* and byte-level
storage are protocol-determined and portable; MIST amounts scale with the live reference gas price and
storage price and must be re-priced for testnet/mainnet. The Groth16 setup used a locally generated
`pot15` (the Hermez ptau URL is not reachable from this sandbox — see Approach) — irrelevant to gas,
which depends on circuit *shape* (VK size, public-input count), not on the toxic waste.

## Approach

**Built** (both reusable, both under `scripts/bench/`):

1. `gas-bench.ts` — publishes the real package to a local Sui network, creates a pool, mints, makes 3
   deposits, builds a two-leaf depth-20 Poseidon Merkle tree so the pool's `commitment_root` matches real
   proofs, sets a withdraw VK and a compliance config, waits for the epoch boundary (60 s minimum epoch),
   then submits **real** Groth16 proofs to `shielded_transfer`, `compliant_transfer` (transfer + compliance
   proof) and `zk_withdraw`, plus a replayed proof that must abort. Records `effects.gasUsed` per tx.
2. `gen-move-gas-test.mjs` — emits `contracts/tests/gas_bench_tests.move`: real VKs/proofs baked into Move
   unit tests, each isolating one verification step, so `sui move test --statistics` reports raw
   Move-VM gas below Sui's billing granularity (see Results — this turned out to be necessary).

**Alternatives rejected:** (a) testnet JSON-RPC history — the fullnode host is blocked by the sandbox
proxy (HTTP 403 on CONNECT), so it was never an option; (b) building `sui` from source — unnecessary,
the release tarball for `testnet-v1.80.1` downloads from `github.com/MystenLabs/sui/releases` (this is
what unblocked the blocker; the GitHub *API* host is denied here but release *downloads* work); (c) reusing
`scripts/src/e2e-test.ts` — it is stale (old `create_pool` arity, 6 public inputs vs 7 now), so a fresh
driver was cheaper than repairing it.

**Toolchain deviations (honest list):** circom 2.2.2 built from `iden3/circom`; `storage.googleapis.com`
Hermez ptau returns 403 here, so a local `pot15` was generated (`snarkjs powersoftau new/contribute/
prepare phase2`, 8m32s) and used for all three zkeys. `snarkjs` under `bun` crashes on worker threads, so
`gas-bench.ts` proves with `{ singleThread: true }`.

## Results

### On-chain (local network, RGP 1000; `bun run bench/gas-bench.ts`, run twice — all 17 rows bit-identical)

All amounts MIST. `computation` is the *billed* (bucketed) figure. net = computation + storage − rebate.

| Entry point | computation | storage cost | rebate | **net** | net (SUI) |
|---|---:|---:|---:|---:|---:|
| `publish` (whole package, one-off) | 1,370,000 | 156,415,600 | 978,120 | 156,807,480 | 0.1568 |
| `create_pool` | 1,000,000 | 8,496,800 | 978,120 | 8,518,680 | 0.0085 |
| `token_faucet::faucet` (testnet only) | 1,000,000 | 4,043,200 | 2,678,544 | 2,364,656 | 0.0024 |
| `deposit_and_register` (each of 3) | 1,000,000 | 10,358,800 | 8,223,732 | 3,135,068 | 0.0031 |
| `update_commitment_root` (propose) | 1,000,000 | 8,740,000 | 8,411,832 | 1,328,168 | 0.0013 |
| `propose_withdraw_vk` | 1,000,000 | 11,970,000 | 8,652,600 | 4,317,400 | 0.0043 |
| `create_compliance_config` | 1,000,000 | 18,171,600 | 11,850,300 | 7,321,300 | 0.0073 |
| `propose_withdrawal` | 1,000,000 | 12,517,200 | 12,091,068 | 1,426,132 | 0.0014 |
| `cancel_withdrawal` | 1,000,000 | 12,213,200 | 12,392,028 | 821,172 | 0.0008 |
| `freeze_pool` / `unfreeze_pool` | 1,000,000 | 12,213,200 | 12,091,068 | 1,122,132 | 0.0011 |
| **`shielded_transfer`** (real proof) | 1,000,000 | 14,485,600 | 12,610,224 | **2,875,376** | 0.0029 |
| `shielded_transfer` replay (aborts) | 1,000,000 | 10,442,400 | 10,337,976 | 1,104,424 | 0.0011 |
| **`compliant_transfer`** (2 proofs) | 1,000,000 | 22,556,800 | 18,268,272 | **5,288,528** | 0.0053 |
| **`zk_withdraw`** (real proof) | 1,000,000 | 15,823,200 | 12,369,456 | **4,453,744** | 0.0045 |

**Finding 1 — computation is pinned to Sui's minimum bucket.** Every transaction, including the two
that verify two Groth16 proofs' worth of pairings, is billed exactly 1,000 gas units of computation
(1,000,000 MIST at RGP 1000). Sui bills computation in buckets and the first bucket is 1,000 units, so
on-chain gas cannot resolve anything cheaper than that. To see *inside* the bucket, the Move-VM gas
meter was read directly.

### Inside the bucket (`node scripts/bench/gen-move-gas-test.mjs && cd contracts && sui move test --build-env testnet --statistics`)

Raw column is "Gas Used" from the test table; units = value − 49,999,995,000,000 (the constant floor that
the empty-body control test reports as `…000001`, i.e. 1). Each step is cumulative over the previous.

| Step (real VK + proof) | transfer | withdraw | compliance |
|---|---:|---:|---:|
| control (empty test) | 1 | 1 | 1 |
| + parse proof & inputs (b) | 1 | 1 | 1 |
| + `prepare_verifying_key` (c) | 84 | 84 | 84 |
| full `verifier::verify_*_proof` (d) | 267 | 248 | 257 |

(Interpretation, not measured: the `verifier.move` comment says the per-call VK preparation costs
"~82K gas"; measured 83 units, which matches if that comment is in internal cost units of 1/1000
gas unit. I did not verify the scaling independently — treat the unit interpretation as an inference and
the *ratios* as the measurement.)

So one full verification ≈ **250–270 gas units**, of which VK preparation ≈ 83 (≈ 31% of transfer
verify). `compliant_transfer` verifies two proofs ≈ 524 units, still under the 1,000 floor.

### Falsification

**The hypothesis is false.** Verification is not what a Veil transfer costs. For `shielded_transfer`,
net cost is 2.88M MIST of which computation is 1.0M (and only ~0.27M of that is pairing work — the rest
is the bucket floor). The dominant *variable* cost is **storage**: `storage_cost` 14.5M with 12.6M
rebated (inference, not separately measured: the shared `Pool` object, which embeds the 4 KB transfer VK, is
rewritten and re-charged on every mutation and mostly refunded); the net ≈ 2.9–3.1M MIST per **new dynamic field** — same order
for a deposit (1 new commitment field, 3.14M) and a transfer (−1 commitment, +1 nullifier, +1 new
commitment ⇒ net +1 field, 2.88M). Nullifier fields are never deleted, so this is permanent state
growth paid by the sender (or the relayer).

### Move test suite

`sui move test --build-env testnet`: **137 passed, 0 failed** (124 existing + 13 new `gas_bench_*`).
Circuits: `test/{transfer,compliance,withdraw}.test.mjs` 43/30/35 pass (run individually). Scripts:
`bun run test` 109 pass. Frontend not touched, not run.

## Verdict — **KEEP**

Measurement merged; `BASELINE.md` gas row filled in place. It also changes what the queue should chase
(see below): the two optimisations the README/verifier comments imply — stored `PreparedVerifyingKey`
(saves ≈ 83 units) and proof aggregation (saves at most the ≈ 267-unit pairing work per proof) — both
save **zero billed gas today**, because they operate entirely inside the 1,000-unit floor. The
levers with real MIST value are (1) storage per transfer and (2) how many proofs one PTB can share one
1,000-unit computation floor with.

## Where this could be used

- **Confidential payroll on Sui with a t-of-n auditor board** (2026-07-22 use case): payroll for N
  employees = N transfers; this gives the per-employee on-chain cost (≈ 0.003 SUI net at RGP 1000 plus
  the relayer's sponsorship) and shows that N transfers packed into one PTB can share one computation
  floor — the number a payroll operator budgets against.
- **Any Groth16-on-Sui protocol** (private voting, sealed-bid auctions, ZK-KYC gates): the finding that
  `sui::groth16` verification of a 5–7-input circuit is ≈ 250 units, i.e. inside the minimum bucket, means
  verifier cost is a non-issue on Sui until many proofs/tx; storage design is the real cost model.
  Directly citable in a thesis chapter on "cost model of on-chain ZK verification on object-centric
  L1s vs. EVM (where pairing precompiles dominate)".
- **Relayer-economics chapter**: per-sponsored-transfer cost bounds subsidy under load (queue item on
  relayer throughput).

## Open questions (→ queue)

1. **PTB batching:** N `shielded_transfer` calls in one PTB — does computation stay in the 1,000-unit
   bucket up to ⌊1000/267⌋ = 3 proofs and step to the next bucket after? Measure marginal net cost/transfer
   at N = 1…10. (Cheap: extend `gas-bench.ts`.)
2. **Storage per transfer:** what does the ≈ 2.9M MIST/field split into (dynamic-field object vs
   `Pool` object growth)? Would a bitmap/Merkle nullifier accumulator or storing only a hash-truncated
   key reduce it? Ties into queue item on the Merkle accumulator at 10^5–10^7 commitments.
3. Re-price on **testnet/mainnet** RGP and storage price (needs a network path the sandbox lacks, or
   a user-run script — `gas-bench.ts` targets `SUI_RPC`).
4. Shared-object contention: the `Pool` is one shared object — sequential here; concurrent-sender
   throughput is unmeasured.
5. `e2e-test.ts` is stale (arity/inputs) — repair or delete; `gas-bench.ts` now supersedes it as the
   working end-to-end driver.

## Reproduce

```
sui start --force-regenesis --with-faucet &          # local network, Sui CLI 1.80.1
sui client switch --env local && sui client faucet
cd circuits && bash scripts/compile.sh && bash scripts/compile-withdraw.sh && bash scripts/compile-compliance.sh
cd ../scripts && bun install && bun run bench/gas-bench.ts        # ~80 s, writes bench/gas-bench-results.json
cd .. && node scripts/bench/gen-move-gas-test.mjs
cd contracts && sui move test --build-env testnet --statistics
```

### Raw output — `bun run bench/gas-bench.ts`

```
address 0x485ad3d79ffa0e2d5679dc9e02ae703d9d78886ebecd66b57f29bea8b1800896  referenceGasPrice 1000
publish (whole package)                      success                        comp=1370000 stor=156415600 reb=978120 net=156807480
create_pool                                  success                        comp=1000000 (1000u) stor=8496800 reb=978120 net=8518680
token_faucet::faucet (mint 1000 VEIL)        success                        comp=1000000 (1000u) stor=4043200 reb=2678544 net=2364656
deposit_and_register (1st commitment)        success                        comp=1000000 (1000u) stor=10358800 reb=8223732 net=3135068
deposit_and_register (2nd commitment)        success                        comp=1000000 (1000u) stor=10358800 reb=8223732 net=3135068
deposit_and_register (3rd commitment)        success                        comp=1000000 (1000u) stor=10358800 reb=8223732 net=3135068
update_commitment_root (propose)             success                        comp=1000000 (1000u) stor=8740000 reb=8411832 net=1328168
propose_withdraw_vk                          success                        comp=1000000 (1000u) stor=11970000 reb=8652600 net=4317400
create_compliance_config                     success                        comp=1000000 (1000u) stor=18171600 reb=11850300 net=7321300
propose_withdrawal                           success                        comp=1000000 (1000u) stor=12517200 reb=12091068 net=1426132
cancel_withdrawal                            success                        comp=1000000 (1000u) stor=12213200 reb=12392028 net=821172
freeze_pool                                  success                        comp=1000000 (1000u) stor=12213200 reb=12091068 net=1122132
unfreeze_pool                                success                        comp=1000000 (1000u) stor=12213200 reb=12091068 net=1122132
waiting for epoch > 29844440 (up to 60 s)...
epoch now 29844441
shielded_transfer (real Groth16 proof)       success                        comp=1000000 (1000u) stor=14485600 reb=12610224 net=2875376
shielded_transfer replay (expect abort)      abort: MoveAbort(MoveLocation  comp=1000000 (1000u) stor=10442400 reb=10337976 net=1104424
compliant_transfer (transfer + compliance proofs) success                        comp=1000000 (1000u) stor=22556800 reb=18268272 net=5288528
zk_withdraw (real Groth16 proof)             success                        comp=1000000 (1000u) stor=15823200 reb=12369456 net=4453744
wrote /home/user/veil/scripts/bench/gas-bench-results.json
```

### Raw output — `sui move test --build-env testnet --statistics` (gas_bench rows)

```
│ veil::gas_bench_tests::gas_bench_compliance_a_load_only                       │   0.628    │      49999995000001       │
│ veil::gas_bench_tests::gas_bench_compliance_b_parse_proof_inputs              │   0.000    │      49999995000001       │
│ veil::gas_bench_tests::gas_bench_compliance_c_prepare_vk                      │   0.007    │      49999995000084       │
│ veil::gas_bench_tests::gas_bench_compliance_d_full_verify                     │   0.015    │      49999995000257       │
│ veil::gas_bench_tests::gas_bench_control_empty                                │   0.000    │      49999995000001       │
│ veil::gas_bench_tests::gas_bench_transfer_a_load_only                         │   0.000    │      49999995000001       │
│ veil::gas_bench_tests::gas_bench_transfer_b_parse_proof_inputs                │   0.000    │      49999995000001       │
│ veil::gas_bench_tests::gas_bench_transfer_c_prepare_vk                        │   0.007    │      49999995000084       │
│ veil::gas_bench_tests::gas_bench_transfer_d_full_verify                       │   0.016    │      49999995000267       │
│ veil::gas_bench_tests::gas_bench_withdraw_a_load_only                         │   0.000    │      49999995000001       │
│ veil::gas_bench_tests::gas_bench_withdraw_b_parse_proof_inputs                │   0.000    │      49999995000001       │
│ veil::gas_bench_tests::gas_bench_withdraw_c_prepare_vk                        │   0.007    │      49999995000084       │
│ veil::gas_bench_tests::gas_bench_withdraw_d_full_verify                       │   0.015    │      49999995000248       │
Test result: OK. Total tests: 137; passed: 137; failed: 0
```
