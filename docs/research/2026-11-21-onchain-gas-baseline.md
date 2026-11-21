# 2026-11-21: on-chain gas per entry point (queue item #1)

## Hypothesis

Real on-chain gas for every user-facing Veil entry point (`deposit_and_register`,
`shielded_transfer`, `compliant_transfer`, `zk_withdraw`) and the main admin operations can be
measured from real transactions, with real Groth16 proofs, on a local Sui network. That fills the
last **BLOCKED** row of `BASELINE.md`. A secondary, falsifiable claim was already in the code:
`contracts/sources/verifier.move` says that preparing the VK on every call costs "~82K gas" and
that storing a `PreparedVerifyingKey` would save it. Tonight's measurements test that claim
against real transactions.

## How the toolchain got unblocked

The 2026-07-22 run was blocked by "no `sui` CLI, no network". This time:

| Need | What worked | What did not |
|---|---|---|
| `sui` CLI | Prebuilt `sui-testnet-v1.84.1-ubuntu-x86_64.tgz` from the GitHub release asset URL (the redirect to the object store is allowed) | `api.github.com` (403), public fullnodes `fullnode.{testnet,mainnet}.sui.io` (403) |
| A chain | `sui start --with-faucet --force-regenesis` (local 4-validator network, RGP 1000) | n/a. Testnet and mainnet are unreachable from this sandbox |
| `circom` 2.2.2 | `cargo build --release` from the `iden3/circom` git tag (the sparse crates index and `static.crates.io` are reachable) | n/a |
| pot15 ptau | PSE perpetual powers of tau, `ppot_0080_15.ptau` (sha256 `4a8eb5a7…2f3d`) | Hermez `storage.googleapis.com` / S3 URLs used by `compile*.sh` (403). The circuit scripts' default ptau URL is now unreachable from this sandbox |
| JSON-RPC | n/a | sui 1.84's node no longer serves JSON-RPC on :9000 (404). The harness uses `SuiGrpcClient` |

Constraint counts after a fresh compile match `BASELINE.md` exactly (13,611 / 12,743 / 3,058).
Only the ptau changed, and it does not affect constraint counts or gas: Groth16 verification
cost depends on the curve and the number of public inputs, not on the setup's toxic waste.

## Threat / privacy model

**For the measurement itself.** Gas is a DoS and economic-viability quantity. The adversary who
cares is a **griefer**, who wants to make the pool expensive to use or to fill it with state, and
**the protocol itself**, which needs to know whether privacy is affordable. Gas numbers move
STRIDE **D1–D6** (denial of service) from qualitative to quantitative. They say nothing about
soundness or privacy.

**What the run actually surfaced.** Building a harness that drives every entry point with real
proofs meant constructing valid witnesses for `zk_withdraw`. Two of the security properties that
`docs/threat-model.md` lists as **Mitigated** do not hold on-chain. Both were exploited against
the real Move package on the localnet. The transaction effects and the token balance deltas are in
the raw output below.

### F1: deposit commitments are not bound to the deposited amount (STRIDE E4; critical, funds)

- **Adversary.** Any depositor. They need no keys and no collusion.
- **What they do.** Call `deposit_and_register` with 100 TOKEN and a commitment
  `Poseidon(1, X, r, s)` for any `X`, for example the pool's whole balance. The contract stores
  the 32 bytes without inspecting them (`pool.move` `deposit_and_register`). The coin's value and
  the commitment's second field are never related. `withdraw.circom` then treats that field
  (`cumulativeOld`) as a **balance**: it proves `withdrawAmount <= cumulativeOld` and
  `newCommitment = Poseidon(1, cumulativeOld - withdrawAmount, …)`. So a self-chosen `X` is
  withdrawable.
- **Measured.** Deposited 100,000,000 units. `zk_withdraw` of 1,000,000,000 units succeeded.
  Attacker balance Δ = **+1,000,000,000**, which is 10× the deposit, paid out of other users'
  deposits.
- **Semantic root cause.** The same field means two different things. In `transfer.circom` the
  second commitment field is **cumulative spending**: it starts at 0 at genesis and *increases*
  with every transfer, capped at the KYC threshold. In `withdraw.circom` it is a **spendable
  balance** that *decreases*. So even an honest user (genesis `cumulative = 0`, as built by
  `frontend/src/hooks/useDepositAndRegister.ts`) can withdraw nothing right after depositing, and
  can withdraw `cumulative` worth of tokens after transferring. Transferring *raises* what you can
  withdraw. E4's mitigation ("C5 range-checks `withdrawAmount <= cumulativeOld`") is sound in
  isolation and meaningless in composition. The circuit tests (W25/W26) pass because they test the
  circuit, not the deposit→withdraw composition.

### F2: `zk_withdraw` never checks the recipient against the proof (STRIDE E7; critical, funds)

- **Adversary.** Anyone who sees a withdrawal transaction before it lands: a relayer
  (`scripts/src/relayer.ts`), a mempool or validator observer, or anyone a user hands a proof to.
- **What they do.** Copy `proof_bytes` and `public_inputs_bytes`, and substitute their own
  `recipient: address`. `withdraw.circom` declares `recipient` as a **private** input and exposes
  only `recipientHash = Poseidon(8, recipient)`. `zk_withdraw` never recomputes that hash from its
  `recipient` argument. The in-code comment ("changing recipient invalidates the Groth16 proof") is
  false, because `recipient` is not a proof input at all.
- **Measured.** A proof generated for recipient A (`recipientHash = Poseidon(8, A)`) was submitted
  with recipient B, a fresh keypair that never proved anything. It succeeded. B's balance
  Δ = **+100,000,000**.
- **Why tests missed it.** No Move test can produce a real withdraw proof, and no end-to-end test
  calls `zk_withdraw` (the `e2e-test.ts` flow stops at `shielded_transfer`).

### What this run does NOT establish

- Gas on **mainnet or testnet**. Localnet RGP is 1000 MIST, and real networks have their own
  reference gas price. Computation **units** (MIST ÷ RGP) and storage bytes are what carry over;
  the MIST totals do not. Storage price was the localnet genesis default.
- **Shared-object contention.** Every transfer and withdraw takes `&mut Pool`, one shared object.
  Sequential transactions on an idle localnet measure nothing about throughput under concurrency.
- That F1 and F2 are the **only** composition bugs. They are what fell out of driving three entry
  points end to end. The compliance path has an analogous open question (below), which was not
  exploited tonight.

**Assumptions.** Groth16 knowledge-soundness on BN254 and Poseidon collision resistance (both
unchanged). The PSE ptau is used for dev only (RR2 unchanged). The localnet is honest.

**STRIDE mapping.** E4 → **BROKEN (F1)**, E7 → **BROKEN (F2)**, D1–D6 now have numbers.
`docs/threat-model.md` is updated in this PR.

## Approach

1. `scripts/bench/gas-localnet.mjs` publishes `contracts/` to a fresh localnet and creates a pool
   with the minimum 60 s epoch. It stages the timelocked state the user paths need: the commitment
   root (a real two-leaf depth-20 tree), the withdraw VK and a compliance config. It deposits,
   waits one pool-epoch boundary for maturity and timelocks, then submits real transactions. Every
   proof is a fresh `groth16.fullProve` against the compiled circuits and is verified locally
   before submission. Gas is read from `effects.gasUsed`.
2. `scripts/bench/gas-verify-probe.mjs` plus the bench-only Move package `scripts/bench/gas-probe/`.
   Every entry point hit the per-transaction **computation floor** (1,000 units), so a single
   Groth16 verify is invisible at transaction granularity. The probe loops N ∈ {1,5,10,20,40}
   `prepare+verify`, `verify-with-one-prepare`, and `prepare` calls inside one transaction, for all
   three circuits. Per-call cost is the slope above the floor.

**Rejected alternatives.**
- Reading historical gas from the deployed testnet package: no route to any public fullnode.
- `sui client call --dry-run`: dry-run gas is an estimate path. Executed effects are the real
  charge.
- `sui move test --statistics`: it reports Move VM instruction counts, not the protocol's gas
  schedule, and has no real natives cost for groth16 on proof bytes it cannot produce.

## Results

Before tonight, every gas row in `BASELINE.md` read **BLOCKED** and the Move suite read
**NOT RUN**. After:

### Gas per entry point (sui 1.84.1 localnet, RGP 1000 MIST; one run, deterministic)

| Entry point | Computation (units) | Storage (MIST) | Rebate (MIST) | **Net (MIST)** |
|---|---|---|---|---|
| `pool::deposit_and_register` | 1,000 (floor) | 13,588,800 | 11,535,646 | **3,053,154** |
| `pool::shielded_transfer` | 1,000 (floor) | 14,485,600 | 12,736,326 | **2,749,274** |
| `compliance::compliant_transfer` (2 proofs) | 1,000 (floor) | 22,556,800 | 18,450,955 | **5,105,845** |
| `pool::zk_withdraw` | 1,000 (floor) | 15,823,200 | 12,493,151 | **4,330,049** |
| `pool::create_pool` | 1,000 | 8,496,800 | 987,901 | 8,508,899 |
| `compliance::create_compliance_config` | 1,000 | 18,171,600 | 11,968,803 | 7,202,797 |
| `pool::update_commitment_root` | 1,000 | 11,970,000 | 11,725,627 | 1,244,373 |
| `pool::propose_vk_update` / `cancel_vk_update` | 1,000 / 1,000 | 15,929,600 / 12,213,200 | 12,211,979 / 15,928,007 | 4,717,621 / −2,714,807 |
| `pool::propose_withdraw_vk` | 1,000 | 11,726,800 | 8,495,950 | 4,230,850 |
| `pool::propose_compliance_toggle` / `cancel_…` | 1,000 / 1,000 | 12,220,800 / 12,213,200 | 12,211,979 / 12,219,578 | 1,008,821 / 993,622 |
| `pool::freeze_pool` / `unfreeze_pool` | 1,000 / 1,000 | 12,213,200 each | 12,211,979 each | 1,001,221 each |
| publish (6 modules) | 1,380 | 156,415,600 | 4,939,506 | 152,856,094 |
| Replay of a spent `shielded_transfer` | n/a | n/a | n/a | refused at simulation (abort 9 `E_COMMITMENT_CHAIN_BROKEN`), never reaches the chain, no gas charged |

The numbers below are derived from the table with plain arithmetic:
- **Every user-facing call is storage-dominated.** For `shielded_transfer`, computation is
  1,000,000 of 2,749,274 net MIST (36%). The remaining 1,749,274 is net storage: one nullifier and
  one new commitment dynamic field are created and the old commitment field is deleted. Each
  mutation of the shared `Pool` rewrites ~12.2 M MIST of storage, which is almost fully rebated.
  The pure-admin rows with nothing else written (freeze: 12,213,200 storage) show that this is the
  Pool object's own footprint.
- **`compliant_transfer` costs 1.86× `shielded_transfer`**, all of it in storage (the extra
  credential nullifier field plus the `ComplianceConfig` rewrite). Its second Groth16 verify is
  free at the floor.

### Per-call `sui::groth16` cost (computation units; slope from N=20 → N=40)

| Circuit (public inputs) | prepare + verify | verify only (VK prepared once) | prepare only |
|---|---|---|---|
| transfer (7) | **268.5** | 183.0 | 82.5 |
| compliance (6) | 258.5 | 173.5 | 83.0 |
| withdraw (5) | 247.0 | 164.0 | 83.0 |

- **The `verifier.move` "~82K gas" note is confirmed:** 82.5–83 units × RGP 1000 = ~82,500 MIST
  per prepare.
- **The optimisation it recommends saves nothing today.** A whole transfer's verification is
  268.5 units, well under the 1,000-unit per-transaction floor. `compliant_transfer`'s two
  prepare+verify calls (268.5 + 258.5 = 527) are also under it. A stored `PreparedVerifyingKey`
  only pays off once a single transaction verifies more than ~3 proofs, i.e. with batching (queue
  item: batched verification).
- **Verify cost grows ~9.5 units per public input** (164 → 173.5 → 183 for 5 → 6 → 7 inputs).
  Public-input count is a lever, but a small one.

### Exploit probes

| Probe | Expected if the threat model held | Measured |
|---|---|---|
| F1: deposit 100 TOKEN, commitment claims 1,000 TOKEN, `zk_withdraw` 1,000 TOKEN | abort | **SUCCEEDED**, attacker Δ +1,000,000,000 |
| F2: withdraw proof for recipient A, submitted with recipient B | abort | **SUCCEEDED**, B Δ +100,000,000 |

### Full test suite (README / CI commands)

| Layer | Command | Result |
|---|---|---|
| Move | `cd contracts && sui move test` | **124 / 124 pass** (first time measured in this loop; it was NOT RUN on 2026-07-22) |
| Circuits (full-proof mode) | `cd circuits && npm test` | 43 + 30 + 35 pass |
| Converter | `cd scripts && bun run src/test-converter.ts` | 109 pass |
| Compliance utils | `bun run src/test-compliance-utils.ts` | 67 pass |
| Fuzz | `bun run src/fuzz-tests.ts` | 6 properties pass |
| Frontend | `bunx tsc --noEmit && bunx biome check . && bunx vitest run` | clean, clean, 19 pass |

The suite is green **and** two critical exploits succeed. No test covers the deposit→withdraw
composition or the recipient argument. That gap is now in the queue (and the fix PR must add the
tests).

### Raw output

`NO_PROXY=127.0.0.1,localhost node scripts/bench/gas-localnet.mjs` (snarkjs `[INFO]` lines
stripped):

```
=== Veil on-chain gas (localnet) — sui 1.84.1-e83d69069e40, RGP 1000 MIST, node v22.23.5 ===
  [ok]   publish (6 modules)                        comp=1380000 storage=156415600 rebate=4939506 net=152856094
  [ok]   pool::create_pool                          comp=1000000 storage=8496800 rebate=987901 net=8508899
  [ok]   pool::propose_withdraw_vk                  comp=1000000 storage=11726800 rebate=8495950 net=4230850
  [ok]   token_faucet::faucet (1000 TOKEN)          comp=1000000 storage=4043200 rebate=2705329 net=2337871
  [ok]   token_faucet::faucet (1000 TOKEN)          comp=1000000 storage=4043200 rebate=2705329 net=2337871
  [ok]   pool::deposit_and_register (100 TOKEN)     comp=1000000 storage=13588800 rebate=11535646 net=3053154
  [ok]   pool::deposit_and_register (100 TOKEN) #2  comp=1000000 storage=13588800 rebate=11535646 net=3053154
  [ok]   deposit 100 TOKEN, commitment claims 1000 [F1] comp=1000000 storage=13588800 rebate=11535646 net=3053154
  [ok]   deposit 100 TOKEN, commitment claims 100 [F2] comp=1000000 storage=13588800 rebate=11535646 net=3053154
  [ok]   victim deposit 1000 TOKEN                  comp=1000000 storage=13588800 rebate=11535646 net=3053154
  [ok]   pool::update_commitment_root               comp=1000000 storage=11970000 rebate=11725627 net=1244373
  [ok]   compliance::create_compliance_config       comp=1000000 storage=18171600 rebate=11968803 net=7202797
  [ok]   pool::propose_compliance_toggle            comp=1000000 storage=12220800 rebate=12211979 net=1008821
  [ok]   pool::cancel_compliance_toggle             comp=1000000 storage=12213200 rebate=12219578 net=993622
  [ok]   pool::propose_vk_update                    comp=1000000 storage=15929600 rebate=12211979 net=4717621
  [ok]   pool::cancel_vk_update                     comp=1000000 storage=12213200 rebate=15928007 net=-2714807
  [ok]   pool::freeze_pool                          comp=1000000 storage=12213200 rebate=12211979 net=1001221
  [ok]   pool::unfreeze_pool                        comp=1000000 storage=12213200 rebate=12211979 net=1001221
  [wait] 29.12s to the next pool epoch boundary…
  [info] pool epoch now 29920753
  [ok]   pool::shielded_transfer                    comp=1000000 storage=14485600 rebate=12736326 net=2749274
  [rej]  pool::shielded_transfer (replay — must abort) refused before execution: Transaction resolution failed: MoveAbort in 1st command, abort code: 9, in '0x22f7c02b46bae7ca2fe69d8b346d7e95329a0aa6b28c147640486a52064ef825::pool::execute_transfer' (instruction 134)
  [ok]   compliance::compliant_transfer             comp=1000000 storage=22556800 rebate=18450955 net=5105845
  [ok]   pool::zk_withdraw [F1: withdraw 1000 after depositing 100] comp=1000000 storage=15823200 rebate=12493151 net=4330049
  [F1] SUCCEEDED — admin TOKEN balance 600000000 -> 1600000000 (Δ 1000000000); deposited 100_000_000 under this commitment
  [ok]   pool::zk_withdraw [F2: proof for A, recipient=B] comp=1000000 storage=15823200 rebate=12493151 net=4330049
  [F2] SUCCEEDED — non-prover recipient B balance 0 -> 100000000 (Δ 100000000); proof's recipientHash = Poseidon(8, A)

| Entry point | status | computation | storage | rebate | net (MIST) | computation units (÷RGP) |
|---|---|---|---|---|---|---|
| publish (6 modules) | ok | 1380000 | 156415600 | 4939506 | 152856094 | 1380 |
| pool::create_pool | ok | 1000000 | 8496800 | 987901 | 8508899 | 1000 |
| pool::propose_withdraw_vk | ok | 1000000 | 11726800 | 8495950 | 4230850 | 1000 |
| token_faucet::faucet (1000 TOKEN) | ok | 1000000 | 4043200 | 2705329 | 2337871 | 1000 |
| pool::deposit_and_register (100 TOKEN) | ok | 1000000 | 13588800 | 11535646 | 3053154 | 1000 |
| pool::update_commitment_root | ok | 1000000 | 11970000 | 11725627 | 1244373 | 1000 |
| compliance::create_compliance_config | ok | 1000000 | 18171600 | 11968803 | 7202797 | 1000 |
| pool::propose_compliance_toggle | ok | 1000000 | 12220800 | 12211979 | 1008821 | 1000 |
| pool::cancel_compliance_toggle | ok | 1000000 | 12213200 | 12219578 | 993622 | 1000 |
| pool::propose_vk_update | ok | 1000000 | 15929600 | 12211979 | 4717621 | 1000 |
| pool::cancel_vk_update | ok | 1000000 | 12213200 | 15928007 | -2714807 | 1000 |
| pool::freeze_pool | ok | 1000000 | 12213200 | 12211979 | 1001221 | 1000 |
| pool::unfreeze_pool | ok | 1000000 | 12213200 | 12211979 | 1001221 | 1000 |
| pool::shielded_transfer | ok | 1000000 | 14485600 | 12736326 | 2749274 | 1000 |
| compliance::compliant_transfer | ok | 1000000 | 22556800 | 18450955 | 5105845 | 1000 |
| pool::zk_withdraw [F1: withdraw 1000 after depositing 100] | ok | 1000000 | 15823200 | 12493151 | 4330049 | 1000 |
| pool::zk_withdraw [F2: proof for A, recipient=B] | ok | 1000000 | 15823200 | 12493151 | 4330049 | 1000 |
```

`NO_PROXY=127.0.0.1,localhost node scripts/bench/gas-verify-probe.mjs`:

```
=== sui::groth16 per-call gas probe — sui 1.84.1-e83d69069e40, RGP 1000 ===

| circuit | public inputs | variant | N | computation units |
|---|---|---|---|---|
| transfer | 7 | prepare+verify ×N | 1 | 1000 |
| transfer | 7 | prepare+verify ×N | 5 | 1340 |
| transfer | 7 | prepare+verify ×N | 10 | 2670 |
| transfer | 7 | prepare+verify ×N | 20 | 5330 |
| transfer | 7 | prepare+verify ×N | 40 | 10700 |
| transfer | 7 | prepare ×1, verify ×N | 1 | 1000 |
| transfer | 7 | prepare ×1, verify ×N | 5 | 1010 |
| transfer | 7 | prepare ×1, verify ×N | 10 | 1920 |
| transfer | 7 | prepare ×1, verify ×N | 20 | 3750 |
| transfer | 7 | prepare ×1, verify ×N | 40 | 7410 |
| transfer | 7 | prepare ×N only | 1 | 1000 |
| transfer | 7 | prepare ×N only | 5 | 1000 |
| transfer | 7 | prepare ×N only | 10 | 1000 |
| transfer | 7 | prepare ×N only | 20 | 1670 |
| transfer | 7 | prepare ×N only | 40 | 3320 |
| compliance | 6 | prepare+verify ×N | 1 | 1000 |
| compliance | 6 | prepare+verify ×N | 5 | 1290 |
| compliance | 6 | prepare+verify ×N | 10 | 2570 |
| compliance | 6 | prepare+verify ×N | 20 | 5130 |
| compliance | 6 | prepare+verify ×N | 40 | 10300 |
| compliance | 6 | prepare ×1, verify ×N | 1 | 1000 |
| compliance | 6 | prepare ×1, verify ×N | 5 | 1000 |
| compliance | 6 | prepare ×1, verify ×N | 10 | 1830 |
| compliance | 6 | prepare ×1, verify ×N | 20 | 3560 |
| compliance | 6 | prepare ×1, verify ×N | 40 | 7030 |
| compliance | 6 | prepare ×N only | 1 | 1000 |
| compliance | 6 | prepare ×N only | 5 | 1000 |
| compliance | 6 | prepare ×N only | 10 | 1000 |
| compliance | 6 | prepare ×N only | 20 | 1660 |
| compliance | 6 | prepare ×N only | 40 | 3320 |
| withdraw | 5 | prepare+verify ×N | 1 | 1000 |
| withdraw | 5 | prepare+verify ×N | 5 | 1240 |
| withdraw | 5 | prepare+verify ×N | 10 | 2470 |
| withdraw | 5 | prepare+verify ×N | 20 | 4940 |
| withdraw | 5 | prepare+verify ×N | 40 | 9880 |
| withdraw | 5 | prepare ×1, verify ×N | 1 | 1000 |
| withdraw | 5 | prepare ×1, verify ×N | 5 | 1000 |
| withdraw | 5 | prepare ×1, verify ×N | 10 | 1730 |
| withdraw | 5 | prepare ×1, verify ×N | 20 | 3370 |
| withdraw | 5 | prepare ×1, verify ×N | 40 | 6650 |
| withdraw | 5 | prepare ×N only | 1 | 1000 |
| withdraw | 5 | prepare ×N only | 5 | 1000 |
| withdraw | 5 | prepare ×N only | 10 | 1000 |
| withdraw | 5 | prepare ×N only | 20 | 1660 |
| withdraw | 5 | prepare ×N only | 40 | 3320 |
```

`cd contracts && sui move test` (tail):

```
Test result: OK. Total tests: 124; passed: 124; failed: 0
```

`cd circuits && npm test`:

```
Mode: FULL PROOF (snarkjs Groth16)
=== Results: 43 passed, 0 failed ===
Mode: FULL PROOF (snarkjs Groth16)
=== Results: 30 passed, 0 failed ===
Mode: FULL PROOF (snarkjs Groth16)
=== Results: 35 passed, 0 failed ===
```

Toolchain fetch:

```
$ curl -sSL -o sui.tgz https://github.com/MystenLabs/sui/releases/download/testnet-v1.84.1/sui-testnet-v1.84.1-ubuntu-x86_64.tgz -w "%{http_code} %{size_download}\n"
200 1140079043
$ ./sui --version
sui 1.84.1-e83d69069e40
$ curl ... https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau
403
$ curl ... https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_15.ptau
200 37842066
4a8eb5a754ed4710d6ad603c2e1a89c72325a448e4474f8694d2c71c7c272f3d  build/pot15_final.ptau
```

## Verdict: **KEEP** (measurement), with two **critical findings** that outrank everything in the queue

The gas baseline is measured, reproducible, and in `BASELINE.md`. No protocol code changed
tonight: this is a measurement-and-harness PR. F1 and F2 are documented here and in
`docs/threat-model.md` (E4, E7 → **Broken**), and they are queue items #1 and #2. They are **not
fixed in this PR**. Both fixes change a circuit or the deposit semantics, which per the loop's rules
needs its own soundness argument, leakage analysis and negative test.

Sketches for tomorrow, untested and UNMEASURED:
- **F2 fix.** Make `recipient` a public input of `withdraw.circom`, or keep the hash and have
  `zk_withdraw` check `recipientHash == sui::poseidon::poseidon_bn254([8, address_to_field(recipient)])`.
  The address must be reduced or split, because a 256-bit Sui address can exceed the BN254 scalar
  field. Two 128-bit limbs avoid the alias.
- **F1 fix.** Bind the deposit to its value. Either the contract computes
  `commitment = Poseidon(1, amount, inner)` from a client-supplied `inner = Poseidon(r, s)` (the
  contract learns nothing it does not already see: the deposit amount is already public), or a
  deposit proof shows the commitment opens to `coin.value()`. Separately, reconcile the
  cumulative-vs-balance meaning of the second field across `transfer.circom` and
  `withdraw.circom`. Today they contradict each other.

## Where this could be used

- **Composition-soundness auditing for any "commit at deposit, prove at withdraw" pool**
  (Tornado-style mixers, Railgun/Aztec-style shielded pools, Sui confidential-transfer designs).
  The F1 pattern (on-chain deposit accepts opaque commitment bytes, and a later circuit trusts a
  field inside them) is generic. A localnet harness that drives deposit→withdraw end to end with
  real proofs is the cheapest detector. This is a natural case study for a thesis chapter on
  *circuit-contract composition bugs that per-layer test suites cannot see*.
- **Relayer-mediated withdrawal designs on Sui** (gasless withdrawal for privacy-pool users). F2
  is exactly the attack a relayer gets for free. Any protocol hashing a recipient as a private
  input must check that hash on-chain.
- **Sui-specific gas modelling for ZK apps.** "Groth16 verify ≈ 250–270 units, below the
  1,000-unit floor; storage is 60–80% of the bill" applies to any Sui protocol verifying one
  proof per transaction: zkLogin-adjacent apps, ZK voting, private airdrop claims. Batching ~4
  proofs per transaction is where verification cost first becomes visible.

## Open questions → queue

1. Fix F1 (deposit-amount binding plus field-semantics reconciliation), with a localnet regression
   (`gas-localnet.mjs` F1 must flip to REJECTED) and circuit negative tests.
2. Fix F2 (on-chain recipient binding), with the same regression requirement.
3. **Compliance proof binding (suspected, not exploited).** `compliant_transfer` never inspects
   `contextId` (compliance inputs bytes 64..96), and nothing ties the compliance proof's
   `userSecret` to the transfer proof's. A KYC'd user may be able to "lend" compliance proofs
   for another user's transfers. Verify on localnet first.
4. Shared-`Pool` contention: N concurrent `shielded_transfer`s against one shared object (latency
   and abort rate), versus sharding the nullifier/commitment set.
5. Batched verification: with per-verify ≈ 183 units (prepared VK) and a 1,000-unit floor, at
   what N does a PTB of N transfers beat N transactions, and does storing a
   `PreparedVerifyingKey` start to matter there?
6. Storage: the ~12.2 M MIST `Pool` rewrite on every call is rebated, but it is capital the user
   must front. Would moving the VKs out of `Pool` into a separate immutable object cut it?
7. `compile*.sh`'s ptau URL (Hermez on GCS) is unreachable from this sandbox. Should the scripts
   switch to PSE `ppot_0080_15.ptau` (a real multi-party ceremony) as the default?
