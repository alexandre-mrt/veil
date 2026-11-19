# 2026-11-19 — On-chain gas per entry point, and the prepared-VK cache (queue item #1)

## Hypothesis

Caching the Groth16 `PreparedVerifyingKey` on-chain, instead of calling
`groth16::prepare_verifying_key` on every verification as `verifier.move` does today, reduces
the **computation gas of `shielded_transfer`** by the ~82K gas that the comment at the top of
`contracts/sources/verifier.move` claims ("Saves ~82K gas per verification").

The precondition was queue item #1 itself: Veil had never measured on-chain gas for any entry
point. This run measures that first (it now goes into `BASELINE.md`) and then tests the hypothesis
against it.

**Result: falsified.** Every Veil entry point costs exactly **1,000 computation units**, which is the
protocol's minimum, with or without the cache. That includes `compliant_transfer`, which does two
VK preparations and two Groth16 verifications. So the cache saves nothing it can measure. It also
adds **+8,078,800 MIST of storage** on the first verification under each VK.

## Threat / privacy model

**Adversaries considered.**

- **Malicious prover / stale-key attacker.** A cache creates a new soundness risk. If the cached
  PVK ever disagrees with the VK bytes the pool currently holds, then a proof under the *old* VK
  (rotated out through the 1-epoch timelock, `propose_vk_update`) would still verify. That breaks
  T3/D6 in `docs/threat-model.md`: VK rotation stops being a real revocation. The variant clears
  the cache on every path that replaces VK bytes (`apply_pending_vk`, `apply_pending_withdraw_vk`,
  `apply_pending_compliance_vk`). The harness checks this on-chain with a real proof under the old
  VK, submitted after rotation, which must abort with `E_INVALID_PROOF` (3). It does, in both
  builds.
- **Chain observer.** The cache is a dynamic field (`PvkKey{slot}`) on the Pool or
  ComplianceConfig. Its creation shows up in the transaction's object changes on the *first*
  verification after each VK change. That is a one-bit, per-pool, public event, and it is already
  implied by the public VK-update events. A chain observer learns nothing new about any user.
- **Griefing / DoS (D3-like).** The first verifier after a rotation pays the extra 8.08M MIST of
  storage. That is a tiny unfairness and not an attack vector.

**What this does NOT defend against.** It does not affect proof soundness, the trusted setup
(RR2) or any privacy property. It is a cost optimisation and nothing else.

**Unplanned finding: E7 does not hold on-chain.** The harness also checks the recipient binding
claimed by `docs/threat-model.md` E7 ("Changing recipient invalidates the Groth16 proof"). Here is
the check:

1. Generate a withdraw proof whose `recipientHash = Poseidon(8, A)`.
2. Submit it to `zk_withdraw` with `recipient = B`, an unrelated fresh address.
3. **It succeeds and B is paid.** This was reproduced on both builds; raw output is below.

The circuit does bind `recipientHash` to `recipient`, but `zk_withdraw` never checks that
`recipientHash` (bytes 96..128) corresponds to its `recipient` argument. The proof therefore
binds to a hash that nothing on-chain compares against. The comment at `pool.move` ("bytes 96-128
(recipientHash) are verified by the proof itself") is wrong.

Who can exploit it:

- any relayer that receives the proof;
- anyone who observes the signed transaction before it lands;
- anyone who reads the proof from a failed or expired transaction.

Any of them can resubmit it to their own address, and the nullifier and change commitment go
through normally. `docs/threat-model.md` E7 is updated to **NOT MITIGATED** in this PR. The fix is
the new queue item #1. This experiment does not fix it, by design: one experiment per night, and
the fix touches the circuit/contract interface (the address→field mapping), so it needs its own
soundness argument and negative test.

**Assumptions.** Gas was measured on protocol version 124: a local network from
`sui 1.72.1-94ad8ccd0ed6`, the exact framework rev pinned in `contracts/Move.toml`, with reference
gas price 1000. Testnet and mainnet may run a different protocol version and RGP; the structure
(a minimum bucket, storage dominating) carries over, but the absolute MIST figures scale with RGP
and the storage price.

**STRIDE mapping.** T3 and D6 (VK rotation, which is what the stale-cache negative test protects).
E7 (status corrected). D3 (cost of griefing, now grounded in a real deposit cost).

## Approach

**Toolchain (the reason this was BLOCKED twice before).** No prebuilt `sui` binary is reachable
from this sandbox: GitHub release downloads return 403, and public fullnodes are refused by the
egress proxy. The fix was:

1. Shallow-fetch `MystenLabs/sui` at exactly the rev pinned in `contracts/Move.toml`
   (`94ad8ccd`).
2. Build the CLI from source:
   `cargo +1.92 build -p sui --bin sui` with `CARGO_PROFILE_DEV_OPT_LEVEL=1`,
   `CARGO_PROFILE_DEV_DEBUG=0`.
   This took **28 min 02 s** on 4 cores and used about 9 GB of disk.
3. Run `sui start --with-faucet --force-regenesis` for a real local validator.

Gas is deterministic per protocol version, so the build profile does not affect any number below.
The Hermez `pot15` ptau download is also blocked (403), so the circuits were re-set up against a
**locally generated pot15** (`snarkjs powersoftau new bn128 15` plus one contribution). Constraint
counts do not depend on the ptau, and gas cannot depend on it either: the VK and proof sizes are
fixed by the curve and the number of public inputs.

**Harness: `scripts/bench/gas-localnet.mjs`.** Each run:

- publishes a fresh copy of the package;
- generates **real Groth16 proofs** with snarkjs against the compiled circuits, using a real
  6-leaf depth-20 Poseidon commitment tree and a 2-leaf credential tree;
- drives every user-facing entry point, plus the main admin ones, through the actual timelocks
  (two real pool-epoch waits, with `epoch_duration_ms = 60 000`);
- records `effects.gasUsed` for every transaction.

It also runs the stale-VK negative test and the E7 probe. The same script is pointed at two
contract trees: the pristine `f942fca` contracts (baseline) and the variant.

**Variant built (rejected).** It is preserved in this branch's history as commit "research(wip):
localnet gas harness + cached prepared-VK variant".

- `verifier::verify_cached(owner_uid, slot, vk_bytes, proof, inputs)` prepares the VK lazily on
  first use and stores the `PreparedVerifyingKey` as a dynamic field. `invalidate_pvk` removes it.
- Each of the three VK-replacement paths calls `invalidate_pvk`.
- A dynamic field was chosen over a struct field because adding fields to `Pool` or
  `ComplianceConfig` is not upgrade-compatible.
- Move suite on the variant: 124/124 passing.

**Alternatives rejected before building:**

- **Eager prepare in `create_pool`.** This would change `create_pool` to abort on malformed VKs,
  and that breaks every Move test that uses `dummy_vk()`.
- **A struct field.** This breaks package upgrades of the already-deployed testnet pool.

## Results

Gas in MIST at RGP = 1000, so computation units = computation MIST ÷ 1000. "Net" means
computation + storage − rebate, which is what the sender actually pays.

| Entry point | Baseline computation | Baseline storage / rebate | Baseline **net** | PVK-cache **net** | Δ net |
|---|---|---|---|---|---|
| `publish` (whole package) | 1,390,000 (1390u) | 156,415,600 / 9,781,200 | **148,024,400** | 152,092,400 | +4,068,000 |
| `pool::create_pool` | 1,000,000 (1000u) | 8,496,800 / 978,120 | **8,518,680** | 8,518,680 | 0 |
| `pool::propose_withdraw_vk` | 1,000,000 | 11,726,800 / 8,411,832 | **4,314,968** | 4,314,968 | 0 |
| `pool::deposit_and_register` (each of 8) | 1,000,000 | 13,588,800 / 11,421,432 | **3,167,368** | 3,167,368 | 0 |
| `compliance::create_compliance_config` | 1,000,000 | 17,928,400 / 11,609,532 | **7,318,868** | 7,318,868 | 0 |
| `pool::update_commitment_root` | 1,000,000 | 12,213,200 / 11,850,300 | **1,362,900** | 1,362,900 | 0 |
| `pool::shielded_transfer` (1st after VK set) | 1,000,000 | 14,485,600 / 12,610,224 | **2,875,376** | 10,954,176 | **+8,078,800** |
| `pool::shielded_transfer` (steady state) | 1,000,000 | 14,485,600 / 12,369,456 | **3,116,144** | 3,116,144 | **0** |
| `pool::zk_withdraw` (1st) | 1,000,000 | 15,823,200 / 12,369,456 | **4,453,744** | 12,046,144 | +7,592,400 |
| `compliance::compliant_transfer` (1st) | 1,000,000 | 22,556,800 / 18,268,272 | **5,288,528** | 13,124,128 | +7,835,600 |
| `compliance::compliant_transfer` (steady) | 1,000,000 | 22,556,800 / 18,268,272 | **5,288,528** | 5,288,528 | 0 |
| `pool::propose_vk_update` | 1,000,000 | 15,686,400 / 11,850,300 | **4,836,100** | 4,836,100 | 0 |
| NEG: proof under rotated-out VK (aborts, code 3) | 1,000,000 | 14,158,800 / 14,017,212 | 1,141,588 | 1,141,588 | 0 |
| `pool::shielded_transfer` (1st after rotation) | 1,000,000 | 14,485,600 / 16,048,692 | **−563,092** | −482,304 | +80,788 |
| `pool::freeze_pool` / `unfreeze_pool` | 1,000,000 | 11,970,000 / 11,850,300 | **1,119,700** | 1,119,700 | 0 |

**What the table says:**

1. **Computation is never the cost.** Every transaction except `publish` lands at the 1,000-unit
   minimum, even `compliant_transfer` with its two preparations and two verifications. The Sui
   protocol config for this protocol version (read via `sui_getProtocolConfig`, shown below)
   charges `groth16_prepare_verifying_key_bn254_cost_base = 82010` and
   `verify…_bn254_cost_base = 115502 + 9484/public input`. Those are *internal* gas units: the "82K"
   in the `verifier.move` comment is this number, read as if it were user gas. **UNMEASURED
   inference:** given the measured results, the internal-to-user-unit ratio must put one full
   verification well under 1,000 units.
2. **Storage is the cost, and it is mostly refundable churn on the Pool object.** A steady-state
   shielded transfer costs **3.12M MIST net** (0.0031 SUI at RGP 1000). About 14.5M of storage is
   charged and 12.4M is rebated, because the shared Pool object is rewritten and one dynamic field
   is swapped for another (commitment out, nullifier and new commitment in).
3. **The cache only adds a stored ~8.08M MIST object.** It saves zero computation units, because
   both builds are at the floor. It adds 8.08M MIST of storage on the first verification per VK and
   +4.07M MIST to `publish` (larger bytecode).
4. **Stale-VK rejection holds in both builds.** A proof under the rotated-out VK aborts with
   `E_INVALID_PROOF`, and a fresh proof under the new VK succeeds.
5. **E7 probe: REDIRECTED in both builds** (see the threat model above).

### Raw output — baseline (`f942fca` contracts)

```
$ sui start --with-faucet --force-regenesis &     # sui 1.72.1-94ad8ccd0ed6, protocol 124, RGP 1000
$ node scripts/bench/gas-localnet.mjs --contracts <pristine f942fca contracts/> --label baseline --json gas-baseline.json
[baseline] publish                            success comp=1390000 (1390u) stor=156415600 rebate=9781200 net=148024400
[baseline] token_faucet::faucet               success comp=1000000 (1000u) stor=4043200 rebate=2678544 net=2364656
[baseline] pool::create_pool                  success comp=1000000 (1000u) stor=8496800 rebate=978120 net=8518680
[baseline] pool::propose_withdraw_vk          success comp=1000000 (1000u) stor=11726800 rebate=8411832 net=4314968
[baseline] pool::deposit_and_register (1st)   success comp=1000000 (1000u) stor=13588800 rebate=11421432 net=3167368
[baseline] pool::deposit_and_register (T2)    success comp=1000000 (1000u) stor=13588800 rebate=11421432 net=3167368
[baseline] pool::deposit_and_register (T3)    success comp=1000000 (1000u) stor=13588800 rebate=11421432 net=3167368
[baseline] pool::deposit_and_register (T4)    success comp=1000000 (1000u) stor=13588800 rebate=11421432 net=3167368
[baseline] pool::deposit_and_register (C1)    success comp=1000000 (1000u) stor=13588800 rebate=11421432 net=3167368
[baseline] pool::deposit_and_register (C2)    success comp=1000000 (1000u) stor=13588800 rebate=11421432 net=3167368
[baseline] pool::deposit_and_register (W1)    success comp=1000000 (1000u) stor=13588800 rebate=11421432 net=3167368
[baseline] pool::deposit_and_register (W2)    success comp=1000000 (1000u) stor=13588800 rebate=11421432 net=3167368
[baseline] compliance::create_compliance_config success comp=1000000 (1000u) stor=17928400 rebate=11609532 net=7318868
[baseline] pool::update_commitment_root       success comp=1000000 (1000u) stor=12213200 rebate=11850300 net=1362900
  waiting for pool epoch 29917894 (root + withdraw VK timelock, deposit maturity)...
[baseline] pool::shielded_transfer (1st)      success comp=1000000 (1000u) stor=14485600 rebate=12610224 net=2875376
[baseline] pool::shielded_transfer (2nd)      success comp=1000000 (1000u) stor=14485600 rebate=12369456 net=3116144
[baseline] pool::zk_withdraw (1st)            success comp=1000000 (1000u) stor=15823200 rebate=12369456 net=4453744
[baseline] compliance::compliant_transfer (1st) success comp=1000000 (1000u) stor=22556800 rebate=18268272 net=5288528
[baseline] compliance::compliant_transfer (2nd) success comp=1000000 (1000u) stor=22556800 rebate=18268272 net=5288528
[baseline] pool::propose_vk_update            success comp=1000000 (1000u) stor=15686400 rebate=11850300 net=4836100
  waiting for pool epoch 29917895 (VK rotation timelock)...
[baseline] NEG stale-VK proof after rotation  failure comp=1000000 (1000u) stor=14158800 rebate=14017212 net=1141588  err=MoveAbort(MoveLocation { module: ModuleId { address: 24b11e63562c8cfc7877a8e23d0091208d54683eb596c0c34e3793134ea42268, name: Identifier("pool") }, function: 4, instruction: 100, function_name: Some("execute_transfer") }, 3) in command 0
[baseline] pool::shielded_transfer (post-rotation) success comp=1000000 (1000u) stor=14485600 rebate=16048692 net=-563092
[baseline] pool::freeze_pool                  success comp=1000000 (1000u) stor=11970000 rebate=11850300 net=1119700
[baseline] pool::unfreeze_pool                success comp=1000000 (1000u) stor=11970000 rebate=11850300 net=1119700
[baseline] E7 recipient-binding probe: REDIRECTED: proof bound to 0x867e6c95e6d42d5dbf348ac8f7d26fa7ee163f340127b52d652fe76451607f0e paid 100 TOKEN units to unrelated address 0x5f420aa6203b2d192f51c90cff7c77f154d65c3be5a26bf434898e1bcf5b247e (digest EZiaXsbYJV9WcTStqa7486gHx24tK9L1Av4WWWncmaU7)
```

### Raw output — PVK-cache variant

```
$ node scripts/bench/gas-localnet.mjs --contracts contracts --label after --json gas-after.json
[after] publish                            success comp=1430000 (1430u) stor=160443600 rebate=9781200 net=152092400
[after] token_faucet::faucet               success comp=1000000 (1000u) stor=4043200 rebate=2678544 net=2364656
[after] pool::create_pool                  success comp=1000000 (1000u) stor=8496800 rebate=978120 net=8518680
[after] pool::propose_withdraw_vk          success comp=1000000 (1000u) stor=11726800 rebate=8411832 net=4314968
[after] pool::deposit_and_register (1st)   success comp=1000000 (1000u) stor=13588800 rebate=11421432 net=3167368
[after] pool::deposit_and_register (T2..W2, 7 more — identical)   comp=1000000 (1000u) stor=13588800 rebate=11421432 net=3167368
[after] compliance::create_compliance_config success comp=1000000 (1000u) stor=17928400 rebate=11609532 net=7318868
[after] pool::update_commitment_root       success comp=1000000 (1000u) stor=12213200 rebate=11850300 net=1362900
  waiting for pool epoch 29917892 (root + withdraw VK timelock, deposit maturity)...
[after] pool::shielded_transfer (1st)      success comp=1000000 (1000u) stor=22564400 rebate=12610224 net=10954176
[after] pool::shielded_transfer (2nd)      success comp=1000000 (1000u) stor=14485600 rebate=12369456 net=3116144
[after] pool::zk_withdraw (1st)            success comp=1000000 (1000u) stor=23415600 rebate=12369456 net=12046144
[after] compliance::compliant_transfer (1st) success comp=1000000 (1000u) stor=30392400 rebate=18268272 net=13124128
[after] compliance::compliant_transfer (2nd) success comp=1000000 (1000u) stor=22556800 rebate=18268272 net=5288528
[after] pool::propose_vk_update            success comp=1000000 (1000u) stor=15686400 rebate=11850300 net=4836100
  waiting for pool epoch 29917893 (VK rotation timelock)...
[after] NEG stale-VK proof after rotation  failure comp=1000000 (1000u) stor=14158800 rebate=14017212 net=1141588  err=MoveAbort(MoveLocation { module: ModuleId { address: 352b73cebf20d2fcde77b31aa196df1f51755789213f883cd83926f2804bbce5, name: Identifier("pool") }, function: 4, instruction: 103, function_name: Some("execute_transfer") }, 3) in command 0
[after] pool::shielded_transfer (post-rotation) success comp=1000000 (1000u) stor=22564400 rebate=24046704 net=-482304
[after] pool::freeze_pool                  success comp=1000000 (1000u) stor=11970000 rebate=11850300 net=1119700
[after] pool::unfreeze_pool                success comp=1000000 (1000u) stor=11970000 rebate=11850300 net=1119700
[after] E7 recipient-binding probe: REDIRECTED: proof bound to 0x5c88baf3122cfdccd3a35a0cb7ee0177bbaf2b9c4f2cbbfafce6f35ed2c48877 paid 100 TOKEN units to unrelated address 0xdfd82cb1d763b1844e8f7fb0b2616a14bbc3825da881741e50847e0eb38cc6b4 (digest E7VbwmzvJvCNTSXNseJRb8d7qM8HtzqrHQhY1kPmHtkR)
```

The seven identical deposit lines in the variant run are collapsed into one line above. All eight
were printed individually, with byte-identical gas to the first.

### Protocol config read from the local validator

```
$ curl -s -X POST localhost:9000 -d '{"jsonrpc":"2.0","id":1,"method":"sui_getProtocolConfig","params":[]}' | <filter>
protocol 124
gas_rounding_step {'u64': '1000'}
groth16_prepare_verifying_key_bn254_cost_base {'u64': '82010'}
groth16_verify_groth16_proof_internal_bn254_cost_base {'u64': '115502'}
groth16_verify_groth16_proof_internal_bn254_cost_per_public_input {'u64': '9484'}
max_gas_computation_bucket {'u64': '5000000'}
obj_data_cost_refundable {'u64': '100'}
storage_gas_price {'u64': '76'}
```

### Test suite (baseline contracts, as merged by this PR)

```
$ cd contracts && sui move test --build-env testnet     → Test result: OK. Total tests: 124; passed: 124; failed: 0
  (variant contracts, same command)                     → Test result: OK. Total tests: 124; passed: 124; failed: 0
$ cd circuits && npm test                                → 43 passed / 30 passed / 35 passed, 0 failed (real Groth16 proofs, 28.6 s)
$ cd scripts && bun run src/test-converter.ts            → Results: 109 passed, 0 failed
$ cd scripts && bun run src/test-compliance-utils.ts     → All tests passed.
$ cd scripts && bun run src/fuzz-tests.ts                → ALL 6 PROPERTIES PASSED
$ cd frontend && bunx tsc --noEmit && bunx biome check . && bunx vitest run   → clean; Tests 19 passed (19)
```

## Verdict

- **PVK cache: REJECT.** It saves 0 computation units, because every Veil transaction is already
  at the 1,000-unit floor. It costs +8.08M MIST of storage per VK version and +4.07M MIST at
  publish. The contract change is **not** merged; it survives in this branch's history.
  - The misleading comment in `verifier.move` is left alone in this PR to keep the diff to
    measurement-only.
  - A rematch would only make sense if a future protocol version lowers the computation floor, or
    if the verifier stops fitting under it (for example a PLONK verifier written in Move).
- **On-chain gas axis of `BASELINE.md`: KEEP.** Measured for the first time and written in.
- **E7: finding.** The threat model is corrected to NOT MITIGATED, and the fix is queued as #1.

## Where this could be used

- **Any Groth16-on-Sui protocol** (zkLogin-style apps, private voting, Sui-native mixers).
  Proof verification is *not* the gas bottleneck on Sui at protocol 124; storage churn on shared
  objects is. Optimisation effort belongs in object layout: fewer dynamic fields per transaction,
  and smaller shared objects to rewrite. Caching VKs or batching proofs for gas does not pay off
  here.
- **Proof aggregation (queue item 3) for N→1 verification** saves nothing on Sui computation gas
  while a single verification sits under the floor. Its remaining value is throughput and
  shared-object contention, not fees. That reframes the thesis chapter on batching: on Sui it is a
  *latency/contention* argument, not a *cost* argument. On EVM chains, the ~200K+ gas pairing
  check is the dominant cost, and the argument is the reverse.
- **Recipient binding as a general lesson.** It applies to private-withdrawal designs (Tornado-
  or Railgun-style pools on Move chains) and to relayer-mediated payouts such as confidential
  payroll disbursement through a third-party relayer. A public input that commits to an
  off-proof parameter (`recipientHash`) is only as good as the on-chain check that recomputes it
  from that parameter. The circuit test suite (W19) can be fully green while the end-to-end
  property is broken. This makes a good case study for the "circuit and contract must be
  co-audited" argument.

## Open questions (feed the queue)

1. **Fix E7 (new #1).** `zk_withdraw` must recompute `Poseidon(8, recipient_field)` on-chain,
   using `sui::poseidon::poseidon_bn254`, and compare it to bytes 96..128.
   - It needs a canonical address→field mapping, because a Sui address is 256 bits and does not
     always fit in the BN254 scalar field. Options are truncating to 253 bits, splitting into two
     limbs (changes the circuit), or `address mod r` (has a collision risk to analyse).
   - It needs a negative test: on-chain, the redirected withdrawal must abort.
   - It needs the relayer flow re-checked.
   - Poseidon on-chain costs extra computation. Does it still fit in the 1,000-unit floor? The
     harness will answer that directly.
2. **What fraction of the 1,000-unit floor does one verification actually use?**
   Approach: a micro-benchmark package that loops `k` verifications per transaction, and finds the
   smallest `k` that leaves the floor. This bounds how much headroom batching or extra on-chain
   Poseidon has before computation starts costing money.
3. **Storage churn per transfer.** 14.5M MIST is charged and 12.4M rebated on every transfer,
   because the whole Pool object is rewritten.
   - Would moving the hot mutable state (the commitment/nullifier sets are already dynamic fields;
     `balance` and the epoch/timelock fields are in the struct) into a smaller object reduce the
     rewrite cost?
   - Would it reduce shared-object contention under concurrent transfers?
4. **Compliance-proof binding.** `compliant_transfer` cannot check `contextId` against the transfer
   proof, because the transfer nullifier is deliberately hidden. Can a credential holder lend
   compliance proofs to a non-KYC'd transfer? Needs a careful analysis next to E7.
5. **Testnet cross-check.** When a network path to a public fullnode is permitted, compare one
   real testnet `shielded_transfer` against these localnet numbers at the testnet RGP.
