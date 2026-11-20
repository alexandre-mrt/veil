# 2026-11-20: On-chain gas per entry point (queue item #1)

## Hypothesis

Veil's on-chain cost per entry point (`deposit_and_register`, `shielded_transfer`,
`compliant_transfer`, `zk_withdraw`, admin ops) can be measured by executing real transactions with
real Groth16 proofs on a local Sui network running the framework rev Veil pins. The hypothesis says
which number should move: per-transfer gas is dominated by Groth16 verification
(`sui::groth16::prepare_verifying_key` + `verify_groth16_proof`), so the optimisation suggested in
`contracts/sources/verifier.move` ("store PreparedVerifyingKey … saves ~82K gas per verification")
would lower what a user pays per transfer.

**The second half is falsified.** Every Veil entry point costs exactly the minimum computation
charge (1,000 units). One Groth16 prepare + verify uses about 267 of those units, and storage
accounts for most of the net cost.

The run also reproduced a real fund-redirect bug on-chain (`docs/threat-model.md` E7, listed there
as "Mitigated"). See Results §4.

## Threat / privacy model

This experiment is mostly a measurement, but it touches two adversaries.

- **Fee-sensitive user / operator (economic).** Pays computation + storage − rebate for every
  transfer, so the question is what Veil's privacy costs per transaction. Today the answer is
  ~0.003–0.005 SUI at a 1,000 MIST reference gas price, and none of it is spent on cryptography.
- **Front-runner / malicious relayer (STRIDE E7).** Sees a pending `zk_withdraw` transaction, or
  is handed one to sponsor. It can read the 128-byte proof and 160-byte public inputs and resubmit
  them with its own `recipient`.
  - *What it observes:* the full transaction, since proofs and inputs are plaintext transaction
    arguments.
  - *What it can do (measured below):* take the withdrawal amount. `pool::zk_withdraw` checks the
    proof against `recipientHash`, but never relates `recipientHash` to the `recipient: address`
    argument it pays out to. The binding in `withdraw.circom` is correct but nothing on-chain
    enforces it.
  - *Residual surface:* the nullifier is consumed by whichever transaction lands first, so the
    honest user's transaction then aborts and their change commitment goes to the attacker's
    transaction as well. The attacker cannot spend that change commitment, because it needs
    `userSecret`. The loss is the withdrawn amount, and the user's remaining balance stays
    spendable by them.
- **Not defended / not measured here:** shared-object contention on `Pool` under concurrent
  transfers. Every entry point takes `&mut Pool`, so all transfers are sequenced through consensus
  on one object, and this single-sender run can't show the latency effect. Relayer timing leakage
  and mainnet gas price volatility are also out of scope.
- **Assumptions:** localnet protocol version 124 (the maximum supported by `sui 1.72.1`, the
  framework rev in `contracts/Move.toml`). Gas schedule parameters were read back from
  `sui_getProtocolConfig` (pasted below). Testnet/mainnet may run a newer protocol version with a
  different schedule. Reference gas price on localnet was 1,000 MIST/unit. The Groth16 keys are
  dev-only (see "Toolchain" below), and VK *size* is the only property that affects gas.
- **STRIDE mapping:** E7 (Elevation: front-run ZK withdrawal) is **refuted as Mitigated**. It's
  confirmed exploitable and has been changed to *Open* in `docs/threat-model.md`. D3 (dynamic-field
  spam) now has a measured per-deposit cost. The other entries are unchanged.

## Approach

**Unblocking the toolchain (the reason this was BLOCKED twice).**

- The prebuilt `sui` binary (GitHub releases API) was refused by the session's GitHub scope (HTTP
  403).
- Direct JSON-RPC to `fullnode.testnet.sui.io` was refused by the egress proxy (HTTP 403,
  `connect_rejected`).
- Git reads of public repos are allowed, so I shallow-cloned `MystenLabs/sui` at
  `testnet-v1.72.1`. That tag resolves to `94ad8ccd…`, exactly the rev `contracts/Move.toml` pins.
  Then I built only the CLI: `CARGO_PROFILE_RELEASE_DEBUG=0 cargo +1.92 build --release --bin sui`.
  The build took **32 m 32 s on 4 cores**, with ~22 GB disk free afterwards.
- A localnet came up with `sui start --with-faucet --force-regenesis`.
- The Hermez `pot15` ptau download is now also refused (GCS and S3 mirrors both HTTP 403), so I
  generated a local 2^15 ptau with `snarkjs powersoftau new/contribute/prepare phase2`. That is
  dev-only, the same trust level as the existing single-contribution setup. Constraint counts came
  out identical to BASELINE (13,611 / 12,743 / 3,058), and VK and proof *sizes* don't depend on the
  ptau.

**What I built.**

- `scripts/bench/gas.ts` runs the whole flow:
  - publishes `contracts/` and creates a pool (`epoch_duration_ms = 60 000`, the contract minimum,
    so the 1-epoch timelocks clear in ~1 minute);
  - makes 12 standard-denomination deposits;
  - sets a commitment root over the deposited leaves and proposes the withdraw VK;
  - creates a `ComplianceConfig` with a real credential tree;
  - waits one pool epoch;
  - then, three times, generates real proofs with `snarkjs.groth16.fullProve`, verifies them
    locally, and executes `shielded_transfer`, `compliant_transfer` (transfer + compliance proof),
    an honest `zk_withdraw`, and the E7 adversarial `zk_withdraw`.

  Every call is a real executed transaction, not a dry run, and the numbers are read from
  `effects.gasUsed`.
- `scripts/bench/groth16-gas/` is a fixture Move package, not part of Veil. Its entry points take
  identical arguments and do: nothing, `prepare_verifying_key` only, prepare + verify (what
  `veil::verifier` does today), or verify against a `PreparedVerifyingKey` stored in a shared
  object (the suggested optimisation). Each also has a `_n` loop variant. A single call sits inside
  the minimum bucket, so I swept n = 1 … 128 to recover per-call cost from the slope.

**Alternatives rejected.**

- Dry-run / `devInspect` would be cheaper, but it doesn't prove the transaction lands. I wanted
  the E7 result as an executed balance change, not a simulation.
- `sui move test` gas statistics use the unit-test VM's meter, which is not the on-chain gas
  schedule.
- Historical testnet transactions via JSON-RPC were blocked, and they would also have mixed
  protocol versions.

## Results

### 1. Gas per entry point (`cd scripts && node bench/gas.ts --runs 3`)

These are local Sui 1.72.1 numbers: protocol v124, reference gas price 1,000 MIST/unit. Costs are
in MIST (1 SUI = 10⁹ MIST). Net = computation + storage − rebate, which is what the sender
actually pays.

| Entry point | n | Computation units | Storage cost | Storage rebate | **Net (MIST)** | Net (SUI) |
|---|---|---|---|---|---|---|
| `shielded_transfer` | 3 | **1,000** (floor) | 14,485,600 | 12,369,456 – 12,610,224 | **2,875,376 – 3,116,144** | ~0.003 |
| `compliance::compliant_transfer` (2 proofs) | 3 | **1,000** (floor) | 22,556,800 | 18,268,272 | **5,288,528** | ~0.0053 |
| `zk_withdraw` | 3 | **1,000** (floor) | 15,823,200 | 12,369,456 | **4,453,744** | ~0.0045 |
| `deposit_and_register` (split + deposit) | 12 | 1,000 | 10,358,800 | 8,223,732 | 3,135,068 | ~0.0031 |
| `create_pool` | 1 | 1,000 | 8,496,800 | 978,120 | 8,518,680 | ~0.0085 |
| `compliance::create_compliance_config` | 1 | 1,000 | 18,171,600 | 11,850,300 | 7,321,300 | ~0.0073 |
| `update_commitment_root` | 1 | 1,000 | 8,740,000 | 8,411,832 | 1,328,168 | ~0.0013 |
| `propose_withdraw_vk` | 1 | 1,000 | 11,970,000 | 8,652,600 | 4,317,400 | ~0.0043 |
| `propose_vk_update` | 1 | 1,000 | 15,929,600 | 12,091,068 | 4,838,532 | ~0.0048 |
| `cancel_vk_update` | 1 | 1,000 | 12,213,200 | 15,770,304 | −2,557,104 (refund) | — |
| `publish` (whole package) | 1 | 1,390 | 156,415,600 | 9,781,200 | 148,024,400 | ~0.148 |

- Gas is fully deterministic. Runs 2 and 3 produced byte-identical summary tables (`diff` empty),
  and all three repetitions inside each run match.
- The only variation is `shielded_transfer` run 0, which also applies the pending commitment root
  lazily.
- **Every proof-verifying entry point is at the computation floor.** 78–87% of the storage line
  comes back as rebate (the rebate rate is 99%, but only on objects the transaction rewrites or
  deletes, not on newly created dynamic fields). Net storage (1.9–4.3 M MIST: shielded 1.9–2.1 M,
  withdraw 3.5 M, compliant 4.3 M) is still 1.9–4.3× the computation charge.

### 2. Where the Groth16 cost actually goes (fixture package, sweep over n)

| Step (Veil transfer VK, 7 public inputs) | Computation at n=64 | at n=128 | **Per call (slope)** | Protocol-config base cost (internal units) |
|---|---|---|---|---|
| empty loop + argument copies (`noop_n`) | 1,000 | 1,000 | < 8 (not resolvable) | — |
| `prepare_verifying_key` only | 5,400 | 10,900 | **≈ 85.9** | `groth16_prepare_verifying_key_bn254_cost_base = 82010` |
| verify with stored `PreparedVerifyingKey` | 11,800 | 23,500 | **≈ 182.8** | `verify…bn254_cost_base 115502 + 7 × 9484 = 181890` |
| prepare + verify (what `veil::verifier` does) | 17,200 | 34,300 | **≈ 267.2** | sum of the two |

- The slopes match the protocol config's native cost table to within ~5%, at a ratio of ~1,000
  internal units per computation unit. That ratio is inferred from the match, not read from a
  config key.
- The "~82K gas" in `verifier.move` is real, but it is **~86 computation units**.
- **A single transfer's Groth16 work (~267 units) is ~27% of the 1,000-unit floor.** Even
  `compliant_transfer`'s two verifications (~534 units) fit under it.
- Storing a `PreparedVerifyingKey` would therefore save **0 MIST per transaction** on every
  current entry point. It would cost extra storage, which I measured: `store_prepared` net
  8,184,280 MIST to create, plus a larger rewritten object on every VK update.
- It only pays once a single transaction carries ≥ 4 verifications. The sweep crosses the floor
  between n = 2 (1,000) and n = 4 (1,090) for prepare + verify, and between n = 4 (1,000) and
  n = 8 (1,510) for prepared verify.

### 3. Implications for the queue (derived from the measured numbers above, not separately measured)

- **Batching proofs (queue #3) can't save computation** until a batch exceeds ~3 transfers. Below
  that, it only saves the per-transaction floor (1,000 units = 1 M MIST) and duplicated object
  rewrites.
- **Storage is the lever.** `shielded_transfer` writes 14,485,600 MIST of storage.
  - At `storage_gas_price` 76 × `obj_data_cost_refundable` 100 = 7,600 MIST/byte, that is
    ≈ 1,906 bytes rewritten per transfer.
  - `Pool` is rewritten on every call, and it carries `transfer_vk` (488 B) and `withdraw_vk`
    (424 B) inline.
  - The non-refundable 1% of each rewrite, plus the two new dynamic fields (nullifier, new
    commitment) minus the one removed, is what the user actually pays.
- Moving the VKs out of the hot `Pool` object is the next measurable gas experiment (new queue
  item).

### 4. E7 reproduction: `zk_withdraw` pays an address the proof does not commit to

In each of the 3 repetitions, the harness proves a withdrawal with
`recipientHash = Poseidon(8, sender)` and submits it with `recipient = <fresh attacker address>`.
**All 3 were accepted, and each paid 40,000,000 TOKEN to the attacker address.**

```
[E7] VIOLATED — redirected withdrawal ACCEPTED ; proof recipientHash=Poseidon(8, 0x72cdefd3…) ; tx recipient=0xe9b61da5… ; status=success ; TOKEN balance changes=[{"owner":{"AddressOwner":"0xe9b61da53fe2bc0b1366ee1e2c83cce24b9cb6583b5e567263b1a705e5301fa…"},"amount":"40000000"}]
```

**Root cause.** `contracts/sources/pool.move`, `zk_withdraw`. The inline comment says "bytes
96-128 (recipientHash) are verified by the proof itself", but that is only true if the recipient
is part of the proof's public statement. Today the recipient is the `recipient: address`
argument, which the contract never hashes or compares.

**Fix shape (not applied tonight; separate PR, top of the queue).** Compute
`sui::poseidon::poseidon_bn254([8, addr_to_field(recipient)])` on-chain and assert it equals
bytes 96..128. `addr_to_field` needs a canonical encoding: a 32-byte Sui address can exceed the
BN254 scalar field, so the circuit and the contract must agree on, e.g., a mod-r reduction or a
2-limb split.

**Context.** The frontend's `useWithdraw` currently calls `emergency_withdraw`, not `zk_withdraw`,
so no shipped UI path exercises this yet. A relayer can't alter a user-signed transaction, but
it doesn't need to. `zk_withdraw` has no sender check, so any relayer or mempool observer that
sees the proof bytes can submit its *own* transaction with them.

### 5. Test suite (full CI set, `.github/workflows/ci.yml`)

```
$ sui --version
sui 1.72.1-94ad8ccd0ed6
$ cd contracts && sui move test          # first time this loop has run it
Test result: OK. Total tests: 124; passed: 124; failed: 0
$ cd circuits && npm test
=== Results: 43 passed, 0 failed ===    (transfer)
=== Results: 30 passed, 0 failed ===    (compliance)
=== Results: 35 passed, 0 failed ===    (withdraw)
$ cd scripts && bun run src/test-converter.ts        -> All tests passed.
$ cd scripts && bun run src/test-compliance-utils.ts -> All tests passed.
$ cd scripts && bun run src/fuzz-tests.ts            -> ALL 6 PROPERTIES PASSED
$ cd frontend && bunx tsc --noEmit && bunx biome check . && bunx vitest run
tsc exit 0 ; biome exit 0 ; Test Files 3 passed (3) / Tests 19 passed (19)
```

All green. That includes the 124 Move tests, which still pass because none of them exercises
`zk_withdraw` with a mismatched recipient. That gap is the finding.

### Raw output

The full filtered log of the canonical run (144 lines: every `[gas]`, `[E7]`, `[env]` line and
the summary table) is committed at
[`data/2026-11-20-gas-run.log`](data/2026-11-20-gas-run.log). The sweep section:

```
| sweep: noop_n(n=1) | 1 | 1000000 | 1000 | 988000 | 978120 | 1009880 |
| sweep: prepare_only_n(n=1) | 1 | 1000000 | 1000 | 988000 | 978120 | 1009880 |
| sweep: prepare_and_verify_n(n=1) | 1 | 1000000 | 1000 | 988000 | 978120 | 1009880 |
| sweep: verify_prepared_n(n=1) | 1 | 1000000 | 1000 | 988000 | 978120 | 1009880 |
| sweep: prepare_and_verify_n(n=2) | 1 | 1000000 | 1000 | 988000 | 978120 | 1009880 |
| sweep: prepare_and_verify_n(n=4) | 1 | 1090000 | 1090 | 988000 | 978120 | 1099880 |
| sweep: verify_prepared_n(n=4) | 1 | 1000000 | 1000 | 988000 | 978120 | 1009880 |
| sweep: prepare_and_verify_n(n=8) | 1 | 2160000 | 2160 | 988000 | 978120 | 2169880 |
| sweep: verify_prepared_n(n=8) | 1 | 1510000 | 1510 | 988000 | 978120 | 1519880 |
| sweep: prepare_only_n(n=16) | 1 | 1370000 | 1370 | 988000 | 978120 | 1379880 |
| sweep: prepare_and_verify_n(n=16) | 1 | 4290000 | 4290 | 988000 | 978120 | 4299880 |
| sweep: verify_prepared_n(n=16) | 1 | 2970000 | 2970 | 988000 | 978120 | 2979880 |
| sweep: prepare_only_n(n=32) | 1 | 2710000 | 2710 | 988000 | 978120 | 2719880 |
| sweep: prepare_and_verify_n(n=32) | 1 | 8560000 | 8560 | 988000 | 978120 | 8569880 |
| sweep: verify_prepared_n(n=32) | 1 | 5900000 | 5900 | 988000 | 978120 | 5909880 |
| sweep: noop_n(n=64) | 1 | 1000000 | 1000 | 988000 | 978120 | 1009880 |
| sweep: prepare_only_n(n=64) | 1 | 5400000 | 5400 | 988000 | 978120 | 5409880 |
| sweep: prepare_and_verify_n(n=64) | 1 | 17200000 | 17200 | 988000 | 978120 | 17209880 |
| sweep: verify_prepared_n(n=64) | 1 | 11800000 | 11800 | 988000 | 978120 | 11809880 |
| sweep: noop_n(n=128) | 1 | 1000000 | 1000 | 988000 | 978120 | 1009880 |
| sweep: prepare_only_n(n=128) | 1 | 10900000 | 10900 | 988000 | 978120 | 10909880 |
| sweep: prepare_and_verify_n(n=128) | 1 | 34300000 | 34300 | 988000 | 978120 | 34309880 |
| sweep: verify_prepared_n(n=128) | 1 | 23500000 | 23500 | 988000 | 978120 | 23509880 |
```

Protocol gas parameters, read from the same localnet:

```
$ curl … sui_getProtocolConfig
protocolVersion 124 maxSupported 124
gas_rounding_step 1000
groth16_prepare_verifying_key_bn254_cost_base 82010
groth16_verify_groth16_proof_internal_bn254_cost_base 115502
groth16_verify_groth16_proof_internal_bn254_cost_per_public_input 9484
groth16_verify_groth16_proof_internal_public_input_cost_per_byte 2
max_gas_computation_bucket 5000000
obj_data_cost_refundable 100
storage_gas_price 76
storage_rebate_rate 9900
```

Toolchain/unblock evidence:

```
$ curl https://api.github.com/repos/MystenLabs/sui/releases   -> 403 "GitHub access to this repository is not enabled for this session"
$ curl -X POST https://fullnode.testnet.sui.io:443             -> CONNECT tunnel failed, response 403 (egress proxy)
$ curl https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau      -> 403
$ curl https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_15.ptau      -> 403
$ git clone --depth 1 --branch testnet-v1.72.1 https://github.com/MystenLabs/sui && git rev-parse HEAD
94ad8ccd0ed6c089a9fe072ff80c918b5ab44943
$ CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_INCREMENTAL=0 cargo +1.92 build --release --bin sui
    Finished `release` profile [optimized] target(s) in 32m 32s
```

## Verdict: **KEEP**

The measurement is the deliverable, and it's now in `BASELINE.md`, closing the last BLOCKED axis
plus the NOT RUN Move suite. The "verification dominates gas" sub-hypothesis is **rejected**, and
with it the motivation for the `PreparedVerifyingKey` refactor at current transaction shapes.
`docs/threat-model.md` E7 is corrected from *Mitigated* to *Open*. No contract or circuit code
changed in this PR.

## Where this could be used

- **Any Groth16-on-Sui protocol** (zkLogin-adjacent apps, private voting, ZK-KYC gates, bridges
  verifying light-client proofs): a single BN254 verification with ≤ ~10 public inputs fits under
  Sui's computation floor, so engineering effort belongs in object layout and storage, not
  verifier micro-optimisation. The sweep fixture (`scripts/bench/groth16-gas`) is
  protocol-agnostic and reusable as is.
- **Proof aggregation on Sui:** the break-even of ~4 verifications per transaction gives a
  concrete lower bound on the batch size at which SnarkPack-style aggregation or recursion starts
  saving computation on Sui (it is not, by itself, an argument for aggregation).
- **Withdrawal-binding pattern in mixers/shielded pools** (Tornado-style "recipient as public
  input"): this is a deployment-level bug class, where the circuit binds correctly but the
  contract never connects the bound value to the payee. It's directly relevant to any thesis
  chapter on the "circuit/contract interface" as an attack surface separate from circuit
  soundness.
- **Confidential payroll on Sui:** per-payment cost of ~0.003 SUI (plain) / ~0.0053 SUI (with a
  compliance proof + auditor ciphertext). A 1,000-employee monthly run costs ~3–5 SUI in gas at
  RGP 1,000.

## Open questions → tomorrow's queue

1. **Fix E7** with on-chain `poseidon_bn254` recipient binding, a canonical address→field
   encoding, and a negative Move test plus a localnet reproducer (`gas.ts` already has one). That
   PR should also record the added gas (`poseidon_bn254` cost) using this harness.
2. **Is the compliance proof bound to the transfer it accompanies?** `compliance.circom` derives
   `contextId = H(6, transferNullifier, userSecret)` from a *private* `transferNullifier`, and
   `compliant_transfer` doesn't check `contextId` against anything in the transfer proof.
   Unverified hypothesis: a KYC'd user can mint compliance proofs that accompany *someone else's*
   transfer ("credential lending"). It needs a localnet reproducer like E7's.
3. **Pool object layout vs storage cost:** move `transfer_vk`/`withdraw_vk` (and pending VK
   buffers) out of the `Pool` object that every transfer rewrites, then measure the net-storage
   delta with `gas.ts`.
4. **Shared-object contention:** N concurrent senders hitting one `Pool`, to measure
   latency/throughput on localnet (the harness is single-sender today).
5. **Does testnet/mainnet run a different protocol version or RGP?** The numbers here are tied to
   v124 / RGP 1,000. Re-run once a network read is permitted.
