# On-chain gas per entry point (plus two binding failures it surfaced)

**Date:** 2026-11-13 · **Queue item:** #1 (blocked twice before) · **Verdict:** KEEP

> **Security headline.** Two real soundness gaps were found as a side effect and reproduced twice
> on a localnet with real Groth16 proofs:
> 1. **`zk_withdraw` does not bind `recipient`.** A valid withdraw proof can be submitted with *any*
>    recipient address and the contract pays it. `docs/threat-model.md` E7 called this
>    "Mitigated". It is not.
> 2. **`compliant_transfer` does not bind the compliance proof to the transfer's owner.** A spender
>    with *no* credential in the credential tree completed a `compliant_transfer` using a
>    compliance proof made from another user's credential.
>
> Neither is fixed in this PR. Tonight's experiment is the gas measurement. Both findings are
> written up below, reflected in `docs/threat-model.md`, and placed at the top of the queue.

## Hypothesis

Veil's on-chain gas, the one axis `BASELINE.md` still listed as BLOCKED, can be measured per entry
point with real Groth16 proofs on a local Sui network. The falsifiable part: **Groth16
verification, not storage, dominates the cost of a `shielded_transfer`.** If that were true, queue
item #3 (batch N transfers into one on-chain verification) would be the main gas lever.

**Result: measurable, yes. Dominant-cost claim: falsified.** Every entry point that verifies a
proof lands in Sui's *minimum* computation bucket (1,000 gas units). In steady state that is 32% of
a `shielded_transfer`'s net cost (1,000,000 of 3,116,144 MIST). The other 68% is net storage.

## Threat / privacy model

**Adversaries this experiment speaks to:**

- **Economic griefer / DoS (STRIDE D-entries).** Gas cost is what bounds spam. With real numbers,
  the cost of flooding the pool's dynamic-field set can be computed exactly. Each
  `deposit_and_register` adds one commitment field for a net 1,797,468 MIST, plus a
  standard-denomination deposit. Before tonight this cost was a guess.
- **Malicious or compromised relayer, or anyone who sees a withdraw proof before it lands (E7).**
  They can take the proof bytes and public inputs and call `zk_withdraw` with their own address as
  `recipient`. They need no secret: the proof stays valid because the contract never recomputes
  `Poseidon(8, recipient)` and compares it to public input `recipientHash` (bytes 96..128). A
  withdraw transaction that aborts for an unrelated reason also puts its proof on-chain without
  spending the nullifier, which makes it a free, replayable proof for anyone. **Observed:** probe
  `withdraw-redirect` succeeded twice. 100 TOKEN reached `0xbebe…be`, an address the prover never
  committed to (tx `4yKoxGRy…`, run 1).
- **A credentialed user who sells or lends compliance (S3 / E5-adjacent).** `compliance.circom`
  binds `contextId = Poseidon(6, transferNullifier, userSecret)`, where `userSecret` is the
  *credential holder's* secret. Nothing proves it equals the *transfer* proof's `userSecret`.
  `transferNullifier` is a private input of the compliance circuit, and on-chain `contextId`
  (compliance bytes 64..96) is never compared with anything in the transfer proof. A KYC'd user who
  sees a stranger's transfer nullifier (public, bytes 128..160 of the transfer inputs) can produce a
  compliance proof for that stranger's transfer without revealing their own secret. **Observed:**
  probe `credential-lending` succeeded twice. The spender at transfer-tree leaf 2R has no
  credential leaf. The compliance proof was built from credential owner #0's secret. The
  transaction emitted `TransferEvent` + `ComplianceVerifiedEvent` (tx `DRP48ksX…`, run 1).

**What this does NOT establish:**
- Mainnet or testnet prices. These are localnet numbers at RGP = 1,000 MIST. Gas *units* and
  storage *bytes* carry over. MIST/SUI totals scale with the network's reference gas price and
  storage price at the time.
- Computation below the 1,000-unit bucket. Sui rounds computation up to buckets, and every
  proof-bearing call reported exactly 1,000,000 MIST. Verification is ≤ 1,000 units, but this
  instrument cannot say by how much.
- Contention. Every transfer, withdraw and deposit takes `&mut Pool`, one shared object, so all of
  them serialize through consensus on that object. Tonight's runs were sequential and measure cost,
  not throughput.
- The relayer's real exposure under E7 depends on whether the frontend or relayer ever hands proof
  bytes to a third party before submission. The contract gap exists either way. That last mile was
  not traced tonight.

**Assumptions:** Groth16 soundness under BN254 q-type/DL assumptions. **Different trusted setup
from the 2026-07-22 baseline:** the Hermez pot15 file is no longer downloadable (both mirrors
return 403, see Approach), so a fresh single-contributor dev pot15 was generated locally. Gas and
constraint counts do not depend on the SRS. Proving time and zkey size were not re-measured.

**STRIDE mapping:** E7 (status changed to **Open**), S3 (credential-nullifier claim, partly
falsified, now **Open**), D-entries (now have a real cost floor). See the `docs/threat-model.md`
diff in this PR.

## Approach

**Unblocking the toolchain (the reason this sat BLOCKED twice):**
1. `api.github.com` returns 403 from this sandbox, but `github.com/.../releases/download/...`
   redirects work, so tags can be probed by HEAD request. Prebuilt
   `sui-testnet-v1.60.0-ubuntu-x86_64.tgz` downloaded fine (837 MB) and **failed to build** the
   package: Move.toml pins framework rev `94ad8cc`, whose `Cargo.toml` says `version = "1.72.1"`,
   and the 1.60 compiler rejects its `internal::Permit` syntax.
2. `testnet-v1.72.1` is exactly that rev (`sui 1.72.1-94ad8ccd0ed6`) and builds cleanly. Only the
   `sui` binary is kept, in the session scratchpad, not the repo.
3. Public fullnodes are blocked by the egress proxy (`fullnode.testnet.sui.io:443 —
   connect_rejected`), so the testnet-history route listed in the queue is closed. `sui start
   --with-faucet --force-regenesis` runs a full localnet in-process instead, which is better
   anyway: no faucet limits and a controlled RGP.
4. circom v2.2.2 was built from source (`cargo build --release`, about 2 minutes).
5. **New breakage found:** the pot15 URL in `circuits/scripts/compile*.sh` *and* in
   `.github/workflows/ci.yml`
   (`storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau`) now returns `403
   AccessDenied`, and the old `hermez.s3-eu-west-1.amazonaws.com` mirror also returns 403.
   `compile.sh` downloads the XML error page as `pot15_final.ptau` and snarkjs fails with
   `Invalid File format`. CI's `curl -fsSL` step should fail the circuit job the same way (inferred from the URL's 403, not
   checked against CI run history tonight). Worked around
   locally with `snarkjs powersoftau new bn128 15 → contribute → prepare phase2` (7m12s, sha256
   `a8d536c0…`). Queued as a fix.

**The harness:** [`scripts/bench/gas-per-entry.mjs`](../../scripts/bench/gas-per-entry.mjs).
It refuses to run unless the active env is `local`. It test-publishes a temporary copy of
`contracts/`, so the repo's Move.lock stays untouched. Then it runs the real protocol:
`create_pool` → (`faucet` + `deposit_and_register`) ×(3R+2) → `update_commitment_root` (a real
depth-20 sparse Poseidon tree over all transfer commitments) → `propose_withdraw_vk` →
`create_compliance_config` (a real credential tree) → wait for the on-chain clock to cross a pool
epoch, which matures the commitments and the timelocks → `shielded_transfer` ×R →
`compliant_transfer` ×R (two proofs each) → `zk_withdraw` ×R → the two binding probes. Every proof
is a real `snarkjs.groth16.fullProve`, verified locally before submission, at the live on-chain
epoch. Gas comes straight from `effects.gasUsed`.

**Rejected alternatives:**
- *Reading historical gas off the deployed testnet package* (the queue's suggestion): the proxy
  blocks fullnodes. Historical txs also mix VK/root states from older package versions.
- *`sui move test` gas*: the unit tests use `test_scenario`, which doesn't charge storage the way
  real transactions do. It would have hidden exactly the storage-dominance result.
- *Dev-inspect / dry-run with bogus proofs*: an invalid proof aborts before the storage writes, so
  it would undercount the dominant cost.
- *bun as the runner*: bun 1.x exited **silently with status 0** inside `groth16.fullProve`. Node
  22 with `--experimental-strip-types` imports the TypeScript proof converter directly and worked.
  The script header documents this.

## Results

### Gas per entry point (localnet, RGP = 1,000 MIST, sui 1.72.1, two fresh deployments, identical numbers)

| Entry point | n | Computation (MIST) | Gas units | Storage (MIST) | Rebate (MIST) | **Net paid (MIST)** | Net (SUI) | Non-refundable |
|---|---|---|---|---|---|---|---|---|
| `publish` (test-publish) | 1 | 1,370,000 | 1,370 | 156,415,600 | 978,120 | **156,807,480** | 0.1568 | 9,880 |
| `pool::create_pool` | 1 | 1,000,000 | 1,000 | 8,496,800 | 978,120 | **8,518,680** | 0.0085 | 9,880 |
| `pool::deposit_and_register` | 11 | 1,000,000 | 1,000 | 9,021,200 | 8,223,732 | **1,797,468** | 0.0018 | 83,068 |
| `pool::update_commitment_root` | 1 | 1,000,000 | 1,000 | 8,740,000 | 8,411,832 | **1,328,168** | 0.0013 | 84,968 |
| `pool::propose_withdraw_vk` | 1 | 1,000,000 | 1,000 | 11,970,000 | 8,652,600 | **4,317,400** | 0.0043 | 87,400 |
| `compliance::create_compliance_config` | 1 | 1,000,000 | 1,000 | 18,171,600 | 11,850,300 | **7,321,300** | 0.0073 | 119,700 |
| `pool::shielded_transfer` (steady state) | 2 | 1,000,000 | 1,000 | 14,485,600 | 12,369,456 | **3,116,144** | 0.0031 | 127,376 |
| `pool::shielded_transfer` (first of epoch, applies pending root) | 1 | 1,000,000 | 1,000 | 14,485,600 | 12,610,224 | **2,875,376** | 0.0029 | — |
| `compliance::compliant_transfer` | 3 | 1,000,000 | 1,000 | 22,556,800 | 18,268,272 | **5,288,528** | 0.0053 | 184,528 |
| `pool::zk_withdraw` | 3 | 1,000,000 | 1,000 | 15,823,200 | 12,369,456 | **4,453,744** | 0.0045 | 124,944 |
| `token_faucet::faucet` (test-only, not a protocol cost) | 11 | 1,000,000 | 1,000 | 4,043,200 | 2,678,544 | 2,364,656 | 0.0024 | 27,056 |

**What the numbers say:**
- **Verification is effectively free on Sui.** Every proof-bearing call, including
  `compliant_transfer` with *two* Groth16 verifications plus 25 lines of byte checks, reports
  exactly the minimum computation bucket. Even ignoring that, computation is 32% of a steady-state
  transfer's net cost, so batching N verifications into one could save at most that 32% per
  transfer. And since every transaction pays at least the 1,000-unit floor, the batched
  transaction would pay the floor too, which shrinks the real saving further. **Queue item #3
  (batched verification) is demoted.** Its saving has a hard ceiling far below the storage cost.
- **Storage is the cost.** A steady-state transfer pays net 2,116,144 MIST for storage: 14,485,600
  charged minus 12,369,456 rebated. The transaction creates two dynamic fields (nullifier + new
  commitment) and deletes one (old commitment), which the effects confirm: `created 2, mutated 2,
  deleted 1`. The nullifier field is never deleted, so the nullifier set's storage grows
  monotonically and is paid for permanently.
- **The Pool object is rewritten on every transaction.** It carries `transfer_vk`, `withdraw_vk`
  and their `pending_*` copies. Each rewrite is charged in full and ~99% rebated, and the 1%
  non-refundable fee recurs per transaction. Compare `create_pool` (8,496,800 storage, one VK) with
  `propose_withdraw_vk` (11,970,000, after the second VK lands in `pending_withdraw_vk`). Moving
  the VKs out of the hot shared object (an immutable VK object, or a dynamic field read by
  reference) would shrink every transaction's storage charge and non-refundable fee.
- **Compliance surcharge = 2,172,384 MIST (+70%) per transfer.** That covers the extra credential
  nullifier field, the 93-byte `encrypted_amount` event, and a second shared object:
  `compliant_transfer` takes `&mut ComplianceConfig` (which holds a third VK) only to apply
  pending timelocks, so the config is rewritten every transfer. That is also a second contention
  point.
- **Deterministic.** Two independent fresh deployments gave bit-identical gas for every entry, so
  n=3 per entry is sufficient. The only variation is the first `shielded_transfer` of an epoch,
  which is cheaper because applying the pending root shrinks the Pool object.

### Raw output — run 2 (`node --experimental-strip-types --no-warnings scripts/bench/gas-per-entry.mjs --runs 3 --out $SCRATCH/gas-run2.json`)

```
sui: sui 1.72.1-94ad8ccd0ed6  env=local  RGP=1000 MIST
runs per proof-bearing entry point: 3
[gas] publish (test-publish)         success  comp=1370000 storage=156415600 rebate=978120 net=156807480
[gas] pool::create_pool              success  comp=1000000 storage=8496800 rebate=978120 net=8518680
[gas] token_faucet::faucet (test-only) success  comp=1000000 storage=4043200 rebate=2678544 net=2364656
[gas] pool::deposit_and_register     success  comp=1000000 storage=9021200 rebate=8223732 net=1797468
   … (faucet + deposit pair repeated 11× total, every line identical) …
[gas] pool::update_commitment_root   success  comp=1000000 storage=8740000 rebate=8411832 net=1328168
[gas] pool::propose_withdraw_vk      success  comp=1000000 storage=11970000 rebate=8652600 net=4317400
[gas] compliance::create_compliance_config success  comp=1000000 storage=18171600 rebate=11850300 net=7321300
waiting for pool epoch > 29909245 ...
epoch 29909246 reached
[gas] pool::shielded_transfer        success  comp=1000000 storage=14485600 rebate=12610224 net=2875376  (first tx of epoch: also applies pending root)
[gas] pool::shielded_transfer        success  comp=1000000 storage=14485600 rebate=12369456 net=3116144
[gas] pool::shielded_transfer        success  comp=1000000 storage=14485600 rebate=12369456 net=3116144
[gas] compliance::compliant_transfer success  comp=1000000 storage=22556800 rebate=18268272 net=5288528
[gas] compliance::compliant_transfer success  comp=1000000 storage=22556800 rebate=18268272 net=5288528
[gas] compliance::compliant_transfer success  comp=1000000 storage=22556800 rebate=18268272 net=5288528
[gas] pool::zk_withdraw              success  comp=1000000 storage=15823200 rebate=12369456 net=4453744  (first call: also applies pending withdraw VK)
[gas] pool::zk_withdraw              success  comp=1000000 storage=15823200 rebate=12369456 net=4453744
[gas] pool::zk_withdraw              success  comp=1000000 storage=15823200 rebate=12369456 net=4453744
[probe] withdraw-redirect:  {"status":"success","coinSentTo":"0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe","digest":"8uwJvNPaETnBRXvyQ6N24jmeamKNMjPUL14nxbxP8qWk"}
[probe] credential-lending: {"status":"success","digest":"4qEfP1v8Q9ifVjSwNsV9F159Bt6YZiNssAdmjZjH9ggd"}

| Entry point | n | computation (MIST) | gas units @RGP 1000 | storage | rebate | net (MIST) | net (SUI) |
|---|---|---|---|---|---|---|---|
| `publish (test-publish)` | 1 | 1370000 | 1370 | 156415600 | 978120 | 156807480 | 0.156807 |
| `pool::create_pool` | 1 | 1000000 | 1000 | 8496800 | 978120 | 8518680 | 0.008519 |
| `token_faucet::faucet (test-only)` | 11 | 1000000 | 1000 | 4043200 | 2678544 | 2364656 | 0.002365 |
| `pool::deposit_and_register` | 11 | 1000000 | 1000 | 9021200 | 8223732 | 1797468 | 0.001797 |
| `pool::update_commitment_root` | 1 | 1000000 | 1000 | 8740000 | 8411832 | 1328168 | 0.001328 |
| `pool::propose_withdraw_vk` | 1 | 1000000 | 1000 | 11970000 | 8652600 | 4317400 | 0.004317 |
| `compliance::create_compliance_config` | 1 | 1000000 | 1000 | 18171600 | 11850300 | 7321300 | 0.007321 |
| `pool::shielded_transfer` | 3 | 1000000 | 1000 | 14485600 | 12369456–12610224 | 2875376–3116144 | 0.003036 |
| `compliance::compliant_transfer` | 3 | 1000000 | 1000 | 22556800 | 18268272 | 5288528 | 0.005289 |
| `pool::zk_withdraw` | 3 | 1000000 | 1000 | 15823200 | 12369456 | 4453744 | 0.004454 |
```

Run 1 (an earlier fresh deployment, same command) produced the identical table. Its probes were
`withdraw-redirect` → success, tx `4yKoxGRyuAQMMrQCAzVk5JcBtsDtNTPCjRecyiZLrA2t`, and
`credential-lending` → success, tx `DRP48ksXhtF23QJjti5JhTVUgafseyFVHzs5Jr16U9GU`.

### Independent confirmation of the redirect (separate CLI query of run 1's probe tx)

```
$ sui client tx-block 4yKoxGRyuAQMMrQCAzVk5JcBtsDtNTPCjRecyiZLrA2t --json | <print status + balanceChanges>
{'status': 'success'}
{'AddressOwner': '0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe'} token::TOKEN 100
{'AddressOwner': '0xd7daf548e01d19810348e34730f1b6b293045f7138eaf37bef098262b91e2b59'} x2::sui::SUI -4453744

$ sui client tx-block DRP48ksXhtF23QJjti5JhTVUgafseyFVHzs5Jr16U9GU --json | <print status + event types>
{'status': 'success'} ['TransferEvent', 'ComplianceVerifiedEvent']
```

### Toolchain resolution (raw)

```
$ ./sui --version                      # testnet-v1.60.0 prebuilt
sui 1.60.0-833c3bbde1f0
$ sui move build                       # → fails against pinned framework
error[E03006]: unexpected name in this position
77 │ public(package) fun redeem<T: store>(withdrawal: Withdrawal<T>, _: internal::Permit<T>): T {
Failed to build Move modules: Compilation error
$ grep -m1 '^version' ~/.move/https___github_com_MystenLabs_sui_git_94ad8cc…/Cargo.toml
version = "1.72.1"
$ ./sui --version                      # testnet-v1.72.1 prebuilt
sui 1.72.1-94ad8ccd0ed6
$ curl -sS -o /dev/null -w '%{http_code}' -r 0-100 https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau
403
$ curl -sS -o /dev/null -w '%{http_code}' -r 0-100 https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_15.ptau
403
$ time (snarkjs powersoftau new bn128 15 … && … contribute … && … prepare phase2 …)
real    7m12.115s
a8d536c0147b4829583f07df2855900f321c8d18003058c512880560ea891682  pot15_final.ptau
```

### Full test suite (CI's job list, `.github/workflows/ci.yml`; there is no `CLAUDE.md` in the repo)

```
contracts$ sui move test                     → Test result: OK. Total tests: 124; passed: 124; failed: 0
circuits$  npm test                          → === Results: 43 passed, 0 failed ===   (transfer)
                                               === Results: 30 passed, 0 failed ===   (compliance)
                                               === Results: 35 passed, 0 failed ===   (withdraw)
                                               real 0m31.289s  (chained npm test no longer hangs — #17's fix holds)
scripts$   bun run src/test-converter.ts     → Results: 109 passed, 0 failed
scripts$   bun run src/test-compliance-utils.ts → Results: 67 passed, 0 failed
scripts$   bun run src/fuzz-tests.ts         → ALL 6 PROPERTIES PASSED
frontend$  bunx tsc --noEmit                 → rc=0
frontend$  bunx biome check .                → rc=0
frontend$  bunx vitest run                   → Test Files 3 passed (3) / Tests 19 passed (19)
```

All green. That green is itself informative: **no existing test catches either binding failure.**
The circuit tests check `recipientHash` *inside* the circuit (W19), and the Move tests never
recompute it on-chain. The suites are self-consistent, and that is why item #5 of the queue
(adversarial audit) was worth keeping.

## Verdict: **KEEP**

`BASELINE.md`'s BLOCKED gas row is replaced with measured numbers, and the Move-test row is now
measured (124/124). The falsified half of the hypothesis is the useful half: Veil's on-chain bill
is storage (nullifier set growth, plus Pool and ComplianceConfig rewrites), not verification. That
re-ranks the scalability queue. No protocol code changed, so `docs/SPEC.md` is untouched.
`docs/threat-model.md` is updated because its *documented* security properties were measured to
be false (E7, and the S3 context-binding claim). The properties didn't change; the documentation
was wrong.

## Where this could be used

- **Any Groth16-on-Sui shielded pool** (mixers, private payroll, private voting): on Sui,
  `sui::groth16` verification sits under the minimum computation bucket. The design budget goes
  to storage layout: nullifier sets as dynamic fields, and keeping VKs out of hot shared objects.
  This is the opposite of the EVM intuition, where the pairing precompile dominates (EVM not
  measured here). That contrast is a thesis section: *"Where the cost of privacy lives: Groth16
  verification vs. state growth on object-centric chains."*
- **Relayer-mediated ZK withdrawals in Move** (any Tornado-style design with a recipient hash): the
  recipient-binding gap is a *class* bug. The circuit commits to `Poseidon(recipient)`, but the
  contract has to recompute it from the actual payee (`sui::poseidon::poseidon_bn254`) or the
  commitment is decorative. The localnet probe in `gas-per-entry.mjs` is a reusable regression
  harness for that class.
- **Compliance-gated confidential transfers with KYC credentials** (e.g. confidential payroll on
  Sui where the employer's auditor board must know every payee is KYC'd): this run shows that a
  "dual-proof" design where the two proofs share no checked public input is two independent
  statements, not one. The fix pattern, putting the transfer's `nullifier` (or an owner-key
  commitment) as a *public* input of the compliance proof and comparing bytes on-chain, applies to
  any dual-proof compliance scheme.

## Open questions (→ queue)

1. **Fix E7:** recompute `recipientHash` on-chain in `zk_withdraw` with
   `sui::poseidon::poseidon_bn254`. The circuit field element must be derived from the 32-byte
   address with the same reduction the client uses, since addresses can exceed the BN254 scalar
   field. Add a Move test that submits a valid proof with a different `recipient` and expects an
   abort. What does the hash cost? It should still sit under the 1,000-unit bucket; measure with
   this harness.
2. **Fix compliance binding:** expose a value the transfer proof also exposes. Two options: make
   `transferNullifier` public in `compliance.circom` and check bytes equality with transfer
   inputs 128..160 on-chain, or prove `Poseidon(userSecret)` equality across both circuits via a
   shared public owner commitment. What does each leak? Making `transferNullifier` public leaks
   nothing new, since the nullifier is already public in the transfer inputs.
3. **VKs out of the Pool object:** how much does each transfer save if `transfer_vk` and
   `withdraw_vk` live in an immutable object (or in dynamic fields not rewritten per tx)? The
   harness can measure it directly. Same for `compliant_transfer` taking `&ComplianceConfig` when
   nothing is pending.
4. **Shared-object contention:** what is sustained TPS for concurrent transfers on one Pool, and
   does sharding commitments across N sub-pools trade anonymity set for throughput?
5. **Restore a reproducible ptau:** pin a working pot15 source with a checksum (or vendor the
   checksum and document local generation) in `compile*.sh` and CI.
