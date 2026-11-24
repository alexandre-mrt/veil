# On-chain gas per entry point (and three broken invariants found while measuring it)

**Date:** 2026-11-24 · **Slug:** `onchain-gas-baseline` · **Queue item:** #1 (BASELINE's one missing axis,
BLOCKED on 2026-07-22) · **Verdict:** **KEEP**

> **Read this first.** While building the gas harness, three security probes were added because
> they cost one transaction each. All three came back **ACCEPTED** on a real localnet with real
> Groth16 proofs. In plain terms: **any depositor can drain the pool (E4)**, **anyone who sees a
> withdrawal proof can redirect the payout (E7)**, and **one KYC credential can make anyone's
> transfer look compliant (BIND)**. `docs/threat-model.md` listed all three as mitigated. Tonight
> does **not** fix them. That takes design work and a circuit change each, and the loop rule is
> one experiment per night. They are now queue items #1–#3.

## Hypothesis

Every Veil entry point's on-chain gas can be measured on one machine from executed transactions
with real proofs. The measured cost of `shielded_transfer` is dominated by **storage**, not by
Groth16 verification. Falsified if verification pushes computation above Sui's minimum
computation bucket.

**Result: confirmed.** All 18 Veil entry points measured (plus publish) sit at the 1,000-unit computation
floor, Groth16 verification included. One full prepare-and-verify costs about 273 computation
units. The money goes to storage (gross) and to the storage-rebate round-trip on the shared
`Pool` object.

## Threat / privacy model

This is a measurement experiment, so it defends against nothing by itself. What it does is pin
down the economics that two adversaries care about, and it ran the probes that showed three
defences were missing.

- **Griefer / spammer (D3).** Each `deposit_and_register` adds a dynamic field. The measured net
  cost per deposit is 3,169,800 MIST (about 0.0032 SUI at RGP 1000) on top of the 100-TOKEN
  minimum deposit. The gas part of the spam cost is negligible next to the deposit lock-up, so
  D3's real defence is the denomination, not gas.
- **Malicious depositor (E4, new finding).** Can do: deposit 100 TOKEN and register a
  commitment whose hidden `cumulativeOld` is any value. Observes: nothing special. Gains: a valid
  `zk_withdraw` proof for up to `cumulativeOld`, paid out of other users' deposits.
  **Demonstrated:** deposit 100,000,000, withdraw 300,000,000.
- **Front-runner (E7, new finding).** Anyone who sees `(proof, public_inputs)` before inclusion
  can do this: a fullnode or validator the user submits through, a relayer, or anyone after a
  failed tx is retried. Can do: resubmit the same bytes with `recipient = self`.
  `zk_withdraw` never recomputes `recipientHash` from its `recipient` argument. Bytes 96..128 are
  checked to be *some* value the proof commits to, but are not bound to the address actually
  paid. **Demonstrated.**
- **Non-KYC'd transferor + one KYC'd accomplice (BIND, new finding).** The compliance proof's
  `contextId = Poseidon(6, transferNullifier, userSecret)` uses private inputs. Nothing ties
  those inputs to the transfer proof in the same tx: neither circuit shares a public signal with
  the other, and `compliant_transfer` only checks that the compliance nullifier is fresh. One
  credential holder can mint compliance proofs for unlimited third-party transfers by picking a
  fresh `transferNullifier` each time. **Demonstrated:** a transfer by secret 2000 was accepted
  with a compliance proof from credential secret 555000111, bound to an unrelated nullifier.

**What tonight does NOT defend against or measure:**
- Testnet/mainnet gas. The reference gas price there differs. Computation *units* should carry
  over at the same protocol version, and MIST scales linearly with RGP.
- Shared-object contention. Every user entry point takes `&mut Pool`, so all of them go through
  consensus on one object. Their throughput ceiling is unmeasured.
- The concurrent-load leakage of the relayer.

**Assumptions:**
- Localnet uses sui 1.71.1's framework and protocol config, not the `Move.toml`-pinned framework
  rev.
- A dev-only single-contributor phase-2 setup on top of the PSE perpetual powers-of-tau
  (`ppot_0080_15`). The Hermez pot15 URL in `compile*.sh` returned 403 from this sandbox.
- Proof validity is unaffected by which ptau file is used. VK *size* is also unaffected:
  488/424/456 bytes on-chain.

**STRIDE mapping (`docs/threat-model.md`):**
- **E4:** marked Mitigated, actually **broken**.
- **E7:** marked Mitigated, actually **broken**.
- **S3 / "context-bound credential nullifiers" control:** the claimed binding does not exist.
- **D3:** quantified (gas share).
- **S2 / T1:** re-confirmed by the NEG probe. A tampered public input aborts with
  `E_INVALID_PROOF` (3).

## Approach

**Toolchain unblocked.** The 07-22 run could not find a `sui` binary. Tonight, GitHub release
assets download fine through the proxy:
- `testnet-v1.60.0` failed to compile the pinned framework (`internal::Permit` unknown).
- `testnet-v1.71.1` builds it, and `sui move test` passes 124/124. This is the first time the
  Move suite has run in this loop.
- circom came from the v2.2.2 release binary.

**Harness:** [`scripts/bench/gas-localnet.ts`](../../scripts/bench/gas-localnet.ts). It does the
following, in order:
1. Publishes the package to a `sui start --with-faucet --force-regenesis` localnet.
2. Creates a pool with `epoch_duration_ms = 60_000`, the contract minimum and the shortest epoch
   it can wait out.
3. Makes 7 deposits and submits the Merkle root.
4. Waits one epoch, so the root applies and the commitments mature.
5. Runs every user entry point with a **fresh real Groth16 proof** for the current epoch, then
   the admin ops.

Each row is read from `effects.gasUsed`, and every executed row is a committed transaction. Rows
marked dry-run are `dryRunTransactionBlock` calls, which return identical gas accounting. Two
extra sets of PTBs isolate the cost of the `sui::groth16` primitives, from 1 up to 64 verifies
in one transaction.

**Rejected alternatives:**
- *Historical gas from the deployed testnet package via JSON-RPC.* It needs network access to a
  public fullnode, which was denied last time. It also only covers whatever transactions happen
  to exist, never admin ops or failure paths, so it is not reproducible.
- *`sui move test --statistics`.* That reports unit-test gas, not transaction gas: no storage
  rebate accounting and no bucketing.
- *Mock proofs.* They would skip the very verification cost under test.

## Results

Reference gas price 1000 MIST. "units" = `computationCost / RGP`. **net** =
computation + storage − rebate, which is what the sender actually pays. All values are in MIST.

### User entry points

| Entry point | units | computation | storage | rebate | net | ≈ SUI net |
|---|---|---|---|---|---|---|
| `pool::deposit_and_register` (×7, identical) | 1,000 | 1,000,000 | 13,832,000 | 11,662,200 | **3,169,800** | 0.0032 |
| `pool::shielded_transfer` #1 (applies pending root) | 1,000 | 1,000,000 | 14,485,600 | 12,610,224 | 2,875,376 | 0.0029 |
| `pool::shielded_transfer` #2, #3 (steady state) | 1,000 | 1,000,000 | 14,485,600 | 12,369,456 | **3,116,144** | 0.0031 |
| `compliance::compliant_transfer` (2 verifies) | 1,000 | 1,000,000 | 22,800,000 | 18,509,040 | **5,290,960** | 0.0053 |
| `pool::zk_withdraw` | 1,000 | 1,000,000 | 15,823,200 | 12,369,456 | **4,453,744** | 0.0045 |

Gas budget the sender must hold: computation + **gross** storage. For example, about 15.5M MIST
for `shielded_transfer` and about 23.8M MIST for `compliant_transfer`.

### Setup / admin

| Entry point | units | computation | storage | rebate | net |
|---|---|---|---|---|---|
| publish (6 modules) | 1,390 | 1,390,000 | 156,415,600 | 9,781,200 | 148,024,400 |
| `pool::create_pool` | 1,000 | 1,000,000 | 8,496,800 | 978,120 | 8,518,680 |
| `compliance::create_compliance_config` | 1,000 | 1,000,000 | 18,171,600 | 11,609,532 | 7,562,068 |
| `pool::propose_withdraw_vk` | 1,000 | 1,000,000 | 11,726,800 | 8,411,832 | 4,314,968 |
| `pool::propose_vk_update` | 1,000 | 1,000,000 | 15,686,400 | 11,850,300 | 4,836,100 |
| `pool::cancel_vk_update` | 1,000 | 1,000,000 | 11,970,000 | 15,529,536 | −2,559,536 |
| `pool::update_commitment_root` | 1,000 | 1,000,000 | 12,213,200 | 11,850,300 | 1,362,900 |
| `pool::propose_withdrawal` / `cancel_withdrawal` | 1,000 | 1,000,000 | 12,274,000 / 11,970,000 | 11,850,300 / 12,151,260 | 1,423,700 / 818,740 |
| `pool::propose_compliance_toggle` / `cancel_…` | 1,000 | 1,000,000 | 11,977,600 / 11,970,000 | 11,850,300 / 11,857,824 | 1,127,300 / 1,112,176 |
| `pool::freeze_pool` / `unfreeze_pool` | 1,000 | 1,000,000 | 11,970,000 | 11,850,300 | 1,119,700 |
| `compliance::update_credential_root` | 1,000 | 1,000,000 | 8,960,400 | 8,630,028 | 1,330,372 |
| `token_faucet::faucet` | 1,000 | 1,000,000 | 4,043,200 | 2,678,544 | 2,364,656 |

### Groth16 primitive cost (transfer VK, 7 public inputs)

| PTB | units |
|---|---|
| `groth16::bn254()` alone (empty-tx floor) | 1,000 |
| 1× prepare + verify | 1,000 (under floor) |
| 2× / 4× / 8× / 16× / 32× / 64× prepare + verify | 1,000 / 1,080 / 2,150 / 4,300 / 8,640 / 17,500 |
| 64× `prepare_verifying_key` only | 5,410 |

**Derived from the rows above** (arithmetic on measured values, not separate measurements):
- One prepare + verify costs about 273 units (17,500 / 64).
- Of that, `prepare_verifying_key` is about 85 units (5,410 / 64) and the pairing check about 188.
- The 1,000-unit floor holds up to about 3 full verifies per transaction.

**Determinism:** runs 2, 3 and 4 were compared row by row on every label they share. There were
**0 differences** in computation, storage, rebate or status (37 and 38 rows compared).
Repeating the run gives no new information, so there is no σ column.

### What the numbers say

1. **Groth16 verification costs nothing at the margin.** All three verifier call paths, including
   `compliant_transfer`'s two verifies, stay under the 1,000-unit minimum.
   - `verifier.move`'s OPTIMIZATION NOTE ("store `PreparedVerifyingKey`… saves ~82K gas") is
     **rejected by measurement**. Preparation is about 85 units (about 85K MIST, so the note's
     figure was the right size). But inside the floor it saves **0 MIST** per transaction.
   - Storing a prepared key would also grow the `Pool` object that every transaction rewrites.
2. **Most of the storage figure is a pass-the-parcel on the `Pool` object.** `freeze_pool`, which
   changes no dynamic fields, still shows 11.97M storage against an 11.85M rebate. The sender
   prepays the whole `Pool` rewrite and gets 99% back.
   - The real per-transaction cost of `Pool` size is the 1% non-refundable fee: about
     120K MIST, roughly 4% of a transfer's net.
   - The net cost of a transfer is about 1.0M computation plus about 2.1M of net dynamic-field
     growth (+nullifier, +new commitment, −old commitment).
3. **Batching proofs into one aggregated on-chain verification is the wrong lever for gas.**
   - At about 273 units per verify, aggregation could save at most the floor amortization.
   - A relayer can already put up to ~3 independent `shielded_transfer` calls in **one PTB with
     no protocol change**. **UNMEASURED** prediction: up to about 2M MIST saved per 3 transfers,
     about 20% of their combined net. This is what the queue's batching item now targets.
   - Storage, the larger share, is unaffected by batching.

### Security probes (same run)

| Probe | Expected if the invariant holds | Observed |
|---|---|---|
| NEG: flip one bit of `txAmountHash` in a valid `shielded_transfer` | abort `E_INVALID_PROOF` (3) | **rejected (3)** ✓ |
| E4: note backed by 100,000,000 deposit, commitment claims 300,000,000, withdraw 300,000,000 | reject | **ACCEPTED**: paid out 300,000,000 |
| E7: proof with `recipientHash = Poseidon(8, A)`, tx passes `recipient = B` | reject | **ACCEPTED**: B received the funds |
| BIND: transfer by secret S₁ + compliance proof by credential secret S₂ ≠ S₁, `transferNullifier` ≠ the transfer's nullifier | reject | **ACCEPTED** |

Root causes, all confirmed in source:
- **E4.** `deposit_and_register` (pool.move:255) stores whatever 32 bytes it is given. The
  denomination check applies to the coin, not to the commitment. `withdraw.circom`'s
  `withdrawAmount <= cumulativeOld` is therefore against a self-declared balance.
  - Separately, `transfer.circom` reads `cumulativeOld` as *spending this epoch* while
    `withdraw.circom` reads it as *balance*. The two circuits disagree on what a note means.
- **E7.** `zk_withdraw` (pool.move:571) never reads bytes 96..128 or compares them to
  `recipient`. The comment at pool.move:595–599 is incorrect.
- **BIND.** In `compliance.circom`, `transferNullifier` and `userSecret` are private and appear
  in no public signal of `transfer.circom`. `compliant_transfer` (compliance.move:266) checks only
  credential root, epoch, KYC level, credential-nullifier freshness and the valid flag.
  `contextId` (bytes 64..96) is never compared to anything.

### Full test suite (unchanged code, all green)

```
contracts$ sui move test            → Test result: OK. Total tests: 124; passed: 124; failed: 0   (real 0m5.6s)
circuits$  npm test                 → Mode: FULL PROOF (snarkjs Groth16)
                                      === Results: 43 passed, 0 failed ===   (transfer)
                                      === Results: 30 passed, 0 failed ===   (compliance)
                                      === Results: 35 passed, 0 failed ===   (withdraw)       (real 0m32.0s)
scripts$   bun run src/test-converter.ts        → Results: 109 passed, 0 failed
scripts$   bun run src/test-compliance-utils.ts → Results: 67 passed, 0 failed
scripts$   bun run src/fuzz-tests.ts            → ALL 6 PROPERTIES PASSED
frontend$  bunx tsc --noEmit → exit 0 ; bunx biome check . → exit 0 ; bunx vitest run → Tests 19 passed (19)
```

The suites are green *and* the three invariants are broken. Nothing tests across the
circuit/contract boundary: no test asks whether the public input the contract reads is the one
the circuit constrains. The E4/E7/BIND probes in `gas-localnet.ts` are the first such tests.
Turning them into Move tests with fixed proof vectors is part of each fix.

### Raw output (run 4, the canonical run)

Command:

```
cd circuits && bash scripts/compile.sh && bash scripts/compile-withdraw.sh && bash scripts/compile-compliance.sh
sui start --with-faucet --force-regenesis &          # sui 1.71.1-2f5992f189cd
cd scripts && bun install && node bench/gas-localnet.ts --transfers 3 --json out.json
```

Full log: [`data/2026-11-24-gas-localnet.log`](data/2026-11-24-gas-localnet.log). Machine-readable:
[`data/2026-11-24-gas-localnet.json`](data/2026-11-24-gas-localnet.json). Excerpt:

```
== Veil localnet gas bench  (sui 1.71.1-2f5992f189cd, RPC http://127.0.0.1:9000, reference gas price 1000 MIST)
   on-chain VK bytes: transfer=488 withdraw=424 compliance=456
  [gas] pool::deposit_and_register #1                success  comp=1000000 (1000 units) storage=13832000 rebate=11662200 net=3169800
  [gas] pool::shielded_transfer #2                   success  comp=1000000 (1000 units) storage=14485600 rebate=12369456 net=3116144
  [gas] ptb: 64x prepare+verify (dry-run)            success  comp=17500000 (17500 units) storage=988000 rebate=978120 net=17509880
  [gas] ptb: 64x prepare_verifying_key only (dry-run) success  comp=5410000 (5410 units) storage=988000 rebate=978120 net=5419880
  [gas] NEG shielded_transfer tampered input (dry-run) failure  comp=1000000 (1000 units) ... err=MoveAbort(pool::execute_transfer, 3)
  [gas] compliance::compliant_transfer               success  comp=1000000 (1000 units) storage=22800000 rebate=18509040 net=5290960
  [gas] pool::zk_withdraw                            success  comp=1000000 (1000 units) storage=15823200 rebate=12369456 net=4453744
  E4: ACCEPTED: note deposited 100000000 base units, withdrew 300000000 (commitment claimed cumulativeOld=300000000; ...)
  E7: ACCEPTED: proof bound to recipientHash=Poseidon(8, 4660) paid 100 base units to unrelated address 0x8917…40c2
  BIND: ACCEPTED: transfer by secret=2000 (...) carried a compliance proof from a different credential holder (secret=555000111) ...
```

Toolchain hashes:
- `sui` 1.71.1: sha256 `6fc36451…9796d`
- `circom` 2.2.2 release binary: sha256 `f3d8d1fd…0fe9d5`
- ptau `ppot_0080_15.ptau`: sha256 `4a8eb5a7…7c272f3d`

Constraint counts were re-derived tonight and match `BASELINE.md` exactly: 13,611 / 12,743 /
3,058.

## Verdict

**KEEP.** `BASELINE.md` gains its gas section and its Move-suite row. The gas axis is no longer
BLOCKED.

Side verdicts:
- `verifier.move`'s "store PreparedVerifyingKey" optimization: **REJECT** (0 MIST saved per
  transaction, measured).
- Threat-model rows E4 and E7 and the context-binding control: corrected to **Broken
  (demonstrated)**.

## Where this could be used

- **Any Groth16-on-Sui protocol's cost model.** Tonight's main transferable fact is that
  per-verify cost is about 273 units against a 1,000-unit floor. That holds for zkLogin-adjacent
  apps, private voting (one verify per ballot), and proof-of-reserves attestations. For all of
  them, the right gas optimisation is storage layout and shared-object size, not the verifier.
- **Relayer-batched private payments on Sui** (for example, a payroll operator submitting N
  employees' shielded transfers per PTB). Floor amortization is the only computation lever, and
  it needs no protocol change.
- **Thesis chapter: "the circuit/contract boundary as an attack surface".** E4, E7 and BIND are
  one bug class. In each, a value the circuit constrains is not the value the contract acts on:
  the deposit amount, the payout address, the paired transfer. It is the same class as the
  Tornado-style "unbound recipient/relayer fee" family and the Zcash-style "value commitment not
  checked against the balance" family. Veil has a clean, measured, three-instance case study.

## Open questions → tomorrow's queue

1. **E4 fix design.** Two options:
   - Commit to the deposit amount on-chain: `deposit_and_register` recomputes or verifies a
     commitment opening, which needs `cumulativeOld` public at deposit time and is linkable
     anyway by denomination.
   - A deposit circuit proving `commitment = Poseidon(1, amount, r, s)` with `amount` public.

   Either way the transfer and withdraw circuits must first agree on what `cumulativeOld` means.
2. **E7 fix.** Recompute `Poseidon(8, recipient_field)` on-chain with
   `sui::poseidon::poseidon_bn254` and compare it to bytes 96..128. Open points:
   - Define the address→field encoding. A 32-byte address can exceed the BN254 modulus, so
     reduce or split it.
   - Measure the gas delta. It should be under the floor.
3. **BIND fix.** Make `contextId` (or the transfer nullifier hash) a shared public signal of
   *both* proofs, and check equality on-chain. This adds a public input to `transfer.circom`.
   Its leakage analysis has to show that the value is already public via the compliance proof
   in the same tx.
4. Does the relayer-PTB batching prediction (about 20% net saving for 3 transfers) hold when
   measured?
5. What is the shared-`Pool` contention ceiling? How many concurrent `shielded_transfer`s per
   second does one shared object sustain on localnet?
