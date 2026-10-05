# 2026-10-05 — On-chain gas baseline (queue item #1)

## Hypothesis

Every Veil entry point can be gas-measured with real Groth16 proofs on a local Sui network (no
testnet/RPC access needed), and the per-transfer cost is dominated by on-chain Groth16 verification,
which would make batched/aggregated verification (queue #3) the next lever.

*(Half of this was falsified — see Verdict. The measurement worked; the "dominated by verification"
premise did not.)*

## Threat / privacy model

This is a measurement experiment, so there is no new defence. The adversary that matters for the
*finding* below is a **front-running relayer / mempool observer** who sees a pending
`zk_withdraw` and can resubmit it.

- **Can do:** copy `(proof, public_inputs)` from a pending withdrawal and submit them first with
  `recipient = their own address`.
- **Observes:** the full transaction (proof, public inputs, recipient argument) — all public.
- **Not defended against, tonight:** this exact attack (see Finding). Gas numbers say nothing about
  privacy; the on-chain footprint per op (one nullifier DF + one commitment DF, no amounts) is
  unchanged.
- **Assumptions:** localnet = same Move VM / `sui::groth16` natives / gas schedule as the 1.72.4
  release; Groth16 keys are from a **locally generated dev-only PoT/zkey** (single contributor) —
  irrelevant to gas and proof size, relevant to the existing RR2.
- **STRIDE mapping:** E7 (front-run ZK withdrawal) in `docs/threat-model.md` — status changed from
  *Mitigated* to **OPEN** by this run. DoS/gas-griefing rows are informed by the numbers.

## Approach

Unblocking the toolchain came first (queue note: "spend the early part of the run on it"):

| Blocker (2026-07-22) | Tonight |
|---|---|
| no `sui` CLI | `github.com/MystenLabs/sui/releases/download/mainnet-v1.72.4/sui-mainnet-v1.72.4-ubuntu-x86_64.tgz` downloads fine through the proxy (v1.50.1 was too old: the pinned framework rev `94ad8cc…` is v1.72.1 and fails to compile on 1.50). Public fullnode RPC is **403 from this sandbox**, so gas comes from a local network instead. |
| circom | built from `iden3/circom` tag `v2.2.2` with `cargo build --release` |
| `pot15` ptau | `storage.googleapis.com/zkevm/…` is **403**; generated a fresh 2^15 ptau with `snarkjs powersoftau new/contribute/prepare phase2` (~8 min, dev-only, 1 contributor) |

`scripts/bench/gas-bench.ts` then drives a full lifecycle on `sui start --force-regenesis`:
publish → `create_pool` → 6 deposits → admin setup (`update_commitment_root`,
`propose_withdraw_vk`, `create_compliance_config`) → wait for the next epoch (maturity +
timelocks) → generate **real** proofs for all three circuits against a real depth-20 Merkle tree →
execute `shielded_transfer` ×3, `compliant_transfer`, `zk_withdraw`, each verified on-chain by
`sui::groth16`. Gas is `effects.gasUsed` of the executed transaction.

Rejected alternatives: *historical testnet gas via `suix_queryTransactionBlocks`* (RPC host
blocked); *`sui move test --statistics`* (Move unit tests use bad/dummy proofs for most paths and
report test-VM gas, not transaction gas).

## Results

Raw output is below. Computation is `computationCost` (MIST); 1 gas unit = 1000 MIST here (reference
gas price 1000). Net = computation + storage − rebate.

| Entry point | Computation (MIST) | Storage cost | Storage rebate | **Net (MIST)** | Net (SUI) |
|---|---|---|---|---|---|
| `deposit_and_register` | 1,000,000 | 9,021,200 | 8,223,732 | **1,797,468** | 0.0018 |
| `shielded_transfer` (1st / 2nd / 3rd) | 1,000,000 | 14,485,600 | 12,610,224 / 12,369,456 / 12,369,456 | **2,875,376 / 3,116,144 / 3,116,144** | 0.0029–0.0031 |
| `compliant_transfer` (2 Groth16 verifies) | 1,000,000 | 22,556,800 | 18,268,272 | **5,288,528** | 0.0053 |
| `zk_withdraw` | 1,000,000 | 15,823,200 | 12,369,456 | **4,453,744** | 0.0045 |
| `create_pool` | 1,000,000 | 8,496,800 | 978,120 | 8,518,680 | 0.0085 |
| `update_commitment_root` (propose) | 1,000,000 | 8,740,000 | 8,411,832 | 1,328,168 | 0.0013 |
| `propose_withdraw_vk` | 1,000,000 | 11,970,000 | 8,652,600 | 4,317,400 | 0.0043 |
| `create_compliance_config` | 1,000,000 | 18,171,600 | 11,850,300 | 7,321,300 | 0.0073 |
| publish (6 modules) | 1,370,000 | 156,415,600 | 978,120 | 156,807,480 | 0.157 |

**What the numbers say**

1. **Computation is a flat floor.** Every transaction — including `compliant_transfer`, which runs
   *two* Groth16 verifications plus the Move-side byte-slicing — was charged exactly 1,000,000 MIST
   (1,000 units), identical to a plain deposit. Groth16 verification is not what Veil pays for.
   *Limit of this measurement:* gas is bucketed, so the run proves "≤ the first computation bucket",
   not the exact unit cost of one verify. I did not independently confirm the bucket boundaries.
2. **Cost is storage churn.** A transfer writes ~14.5M MIST of storage and gets ~12.4M back
   (rebate on the pool object rewrite + the consumed commitment DF); the net ~3.1M is net-new
   bytes (nullifier DF + new commitment DF). Net cost therefore scales with *state growth*, not
   with proof verification.
3. **Deterministic.** 6 deposits are byte-identical in cost; transfers #2/#3 are identical;
   #1 is 240,768 MIST cheaper because it also applied the pending commitment root (clears a
   field, larger rebate). No variance to report beyond that.
4. **Compliance premium** ≈ +2.17M MIST net (+70%) over a plain transfer, all storage (inferred, not itemised: the extra credential-nullifier DF and the ComplianceConfig
   object write), none computation.

### Finding: `zk_withdraw` does not bind the recipient (E7)

`docs/threat-model.md` E7 claimed "Changing recipient invalidates the Groth16 proof." It cannot:
`pool::zk_withdraw` takes `recipient: address` as a free argument, uses it only in
`transfer::public_transfer`, and never relates it to the `recipientHash` public input
(`pool.move:571-632`; the in-code comment at `:595-599` says the proof "verifies" it, but the
proof only attests that *some* recipient hashes to that value).

Probe (in the bench, after the honest withdrawal): a valid proof for `recipientHash =
Poseidon(8, 0xabcdef123456)` was submitted with `recipient =` a freshly generated unrelated
address. Result: **accepted**; that address now holds the withdrawn tokens (raw output below). Any
observer of a pending `zk_withdraw` can therefore redirect its funds. Exposure window: any party that sees the
payload before it is executed — notably the relayer (`scripts/src/relayer.ts`), which receives it
first by design — can substitute the recipient. (I did not test relayer behaviour; this is the
contract-level fact only.) Severity: **high**. Not fixed tonight (scope: one experiment; a fix touches
`withdraw.circom`'s public interface or needs an on-chain Poseidon check and a VK redeploy) —
queued as #1.

### Raw output

Environment:
```
$ sui --version
sui 1.72.4-accfab1708e9
$ node bench/gas-bench.ts   (log: docs/research/raw/2026-10-05-gas-bench.log, json: raw/2026-10-05-gas-bench-result.json)
== publish ==
[gas] publish package                    computation=1370000 storage=156415600 rebate=978120
package=0xecfac7b56a068796707fea29538559ccf9467feda40a41ba70f47e6d83d7d98f referenceGasPrice=1000 MIST/unit
== pool ==
[gas] create_pool                        computation=1000000 storage=8496800 rebate=978120 net=8518680
== mint ==
[gas] token::mint x6 (setup, not a Veil path) computation=1000000 storage=10731200 rebate=2678544 net=9052656
== deposits ==
[gas] deposit_and_register #1            computation=1000000 storage=9021200 rebate=8223732 net=1797468
[gas] deposit_and_register #2            computation=1000000 storage=9021200 rebate=8223732 net=1797468
[gas] deposit_and_register #3            computation=1000000 storage=9021200 rebate=8223732 net=1797468
[gas] deposit_and_register #4            computation=1000000 storage=9021200 rebate=8223732 net=1797468
[gas] deposit_and_register #5            computation=1000000 storage=9021200 rebate=8223732 net=1797468
[gas] deposit_and_register #6            computation=1000000 storage=9021200 rebate=8223732 net=1797468
== admin ==
[gas] update_commitment_root (propose)   computation=1000000 storage=8740000 rebate=8411832 net=1328168
[gas] propose_withdraw_vk                computation=1000000 storage=11970000 rebate=8652600 net=4317400
[gas] create_compliance_config           computation=1000000 storage=18171600 rebate=11850300 net=7321300
== waiting 18s for epoch 29853087 ==
chain epoch now 29853087
== proving ==
== entry points ==
[gas] shielded_transfer #1               computation=1000000 storage=14485600 rebate=12610224 net=2875376
[gas] shielded_transfer #2               computation=1000000 storage=14485600 rebate=12369456 net=3116144
[gas] shielded_transfer #3               computation=1000000 storage=14485600 rebate=12369456 net=3116144
[gas] compliant_transfer (2 Groth16 verifies) computation=1000000 storage=22556800 rebate=18268272 net=5288528
[gas] zk_withdraw                        computation=1000000 storage=15823200 rebate=12369456 net=4453744
== PROBE: zk_withdraw with a recipient the proof never mentioned ==
[gas] zk_withdraw (swapped recipient PROBE) computation=1000000 storage=15823200 rebate=12369456 net=4453744
[PROBE] swapped-recipient withdrawal ACCEPTED; attacker 0x6b1bb4de1b440a58593d91643bb6fd9f08bb6d41cacd1d61aa59acbb5592acad now holds 100 units of TOKEN

| entry point | computation (MIST) | computation (gas units) | storage cost | storage rebate | net MIST |
|---|---|---|---|---|---|
| publish package (6 modules) | 1370000 | 1370 | 156415600 | 978120 | 156807480 |
| create_pool | 1000000 | 1000 | 8496800 | 978120 | 8518680 |
| deposit_and_register #1 | 1000000 | 1000 | 9021200 | 8223732 | 1797468 |
| deposit_and_register #2 | 1000000 | 1000 | 9021200 | 8223732 | 1797468 |
| deposit_and_register #3 | 1000000 | 1000 | 9021200 | 8223732 | 1797468 |
| deposit_and_register #4 | 1000000 | 1000 | 9021200 | 8223732 | 1797468 |
| deposit_and_register #5 | 1000000 | 1000 | 9021200 | 8223732 | 1797468 |
| deposit_and_register #6 | 1000000 | 1000 | 9021200 | 8223732 | 1797468 |
| update_commitment_root (propose) | 1000000 | 1000 | 8740000 | 8411832 | 1328168 |
| propose_withdraw_vk | 1000000 | 1000 | 11970000 | 8652600 | 4317400 |
| create_compliance_config | 1000000 | 1000 | 18171600 | 11850300 | 7321300 |
| shielded_transfer #1 | 1000000 | 1000 | 14485600 | 12610224 | 2875376 |
| shielded_transfer #2 | 1000000 | 1000 | 14485600 | 12369456 | 3116144 |
| shielded_transfer #3 | 1000000 | 1000 | 14485600 | 12369456 | 3116144 |
| compliant_transfer (2 Groth16 verifies) | 1000000 | 1000 | 22556800 | 18268272 | 5288528 |
| zk_withdraw | 1000000 | 1000 | 15823200 | 12369456 | 4453744 |

```

Test suites, all green on this machine (nothing in circuits/contracts/frontend changed tonight):
```
circuits/test/transfer.test.mjs    === Results: 43 passed, 0 failed ===
circuits/test/compliance.test.mjs  === Results: 30 passed, 0 failed ===
circuits/test/withdraw.test.mjs    === Results: 35 passed, 0 failed ===
scripts (bun run test)             Results: 109 passed, 0 failed
contracts (sui move test --build-env testnet)  Test result: OK. Total tests: 124; passed: 124; failed: 0
frontend (vitest run)              Test Files 3 passed (3)   Tests 19 passed (19)
```
(Existing Move tests do not cover the swapped-recipient case — that is why this slipped through.)

Note: circuit constraint counts re-measured on the rebuilt circuits are unchanged (13,611 /
12,743 / 3,058), matching BASELINE.md.

## Verdict: **KEEP** (with a high-severity security finding)

- On-chain gas per entry point: **measured** (this closes BASELINE's last BLOCKED axis; the
  Move test suite is also now run: 124/124).
- The hypothesis's second half is **falsified**: verification is under the computation floor, so
  batched verification (queue #3) would save ~0 computation gas. Re-ranked down.
- Bench is reusable: `cd scripts && node bench/gas-bench.ts` (see the header comment of the file
  for the localnet recipe). It takes ~2.5 min, ~1 of which is a mandatory epoch wait (60 s epoch).
- Caveats: localnet gas schedule/price (price 1000 MIST/unit — mainnet/testnet price floats, storage
  price is a protocol constant); dev ptau; single run (but results are deterministic).

## Where this could be used

- **Confidential payroll on Sui with a t-of-n auditor board:** the 70% compliance premium and the
  fact that it is pure storage tells a payroll operator that per-payslip cost is ~0.005 SUI, flat,
  regardless of auditor-board size (the board only changes off-chain ciphertexts).
- **Any Sui protocol verifying Groth16 on-chain** (private voting, zk-KYC gates, rollup bridges on
  Sui): the computation-floor result means *don't* build aggregation to save verify gas; spend the
  effort on state footprint (nullifier-set representation).
- **Thesis chapter:** "Cost model of ZK payments on object-based chains" — storage-rebate economics
  (a UTXO-style spend that deletes a field gets 99% back) is a Sui-specific lever absent on EVM
  account chains. The E7 finding is also a clean case study for "circuit-claims vs. contract-enforcement
  gaps".

## Open questions (tomorrow's queue)

1. Fix E7 and add the missing negative test (swapped recipient must abort) — on-chain Poseidon via
   `sui::poseidon` vs. making the recipient the only thing the proof can authorize.
2. Is the verify cost really below the first bucket? Find the true per-verify unit cost (e.g. by
   bisecting the max gas budget on a tx that fails with `InsufficientGas`, or replaying with a
   profiler) before ruling out aggregation for *other* chains/fee schedules.
3. Reduce net storage per transfer (~3.1M MIST): can the nullifier set share storage (bitmap /
   bloom-ish table) without hurting the spent-check guarantees?
4. Shared-object contention: every transfer mutates the single `Pool` object (~1.5 KB rewritten per
   tx). Measure max concurrent TPS on a localnet multi-validator setup.
5. Re-measure on a real testnet once the egress policy allows it, to confirm localnet≈testnet.
