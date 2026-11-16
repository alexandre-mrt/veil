# 2026-11-16: public-input binding audit

**Verdict: KEEP** for the audit: the binding table, a reusable real-proof harness and 9 Move tests
are merged. **PARK** for the fix, which needs a circuit redesign (see Open questions).
**Finding: Critical.** The pool has no value conservation: `zk_withdraw` paid out **1000 TOKEN
against a 100 TOKEN deposit (10×)**. I reproduced this twice with real Groth16 proofs on the
unmodified `main` contracts. Honest depositors **cannot withdraw at all**.

## Why this experiment (and not queue items #1/#2 on `main`)

`main`'s queue still lists on-chain gas (#1) and Poseidon2 (#2). Neither is open:

- **On-chain gas: KEEP**, e.g. 2026-11-13, measured on localnet with real proofs.
- **Poseidon2: REJECT**, on 15 or more nights.

`main` looks stale only because none of the ~115 nightly PRs has been merged (the newest are #112–#121, all
open). PR #121 (2026-11-15) recorded this and ranked a **public-input binding audit** first, because
both real vulnerabilities found so far (E7 recipient, E8 compliance owner) belonged to that class.
This is that item, run against `main` (`f942fca`). I did not re-run any settled experiment.

## Hypothesis

> Every public input of `transfer`, `withdraw` and `compliance` is checked on-chain against the
> value it is meant to bind, so a valid proof cannot extract more value than was deposited.
> Number: **value extracted / value deposited ≤ 1** for any sequence of valid proofs.

**Falsified.** Measured ratio: **10.0**. The ceiling is the pool balance, not the deposit.

## Threat / privacy model

**Adversary: a malicious prover.** This is any user with a wallet: no admin key, no compromised
setup, no collusion. They pick their own witnesses, produce valid Groth16 proofs under the pool's
real VK, and call public entry points. They see the whole chain.

**What they can do on `main`:**
1. **V1, forged deposit.** Register a commitment `Poseidon(1, X, r, s)` with a 100 TOKEN coin, then
   one epoch later prove withdraw of `X`. The only cap is `pool.balance` (E4).
2. **V2, transfer inflation. No forgery needed.** Use the frontend's own genesis commitment
   `Poseidon(1, 0, 0, s)`. Make one valid `shielded_transfer` of `txAmount ≤ threshold`, which takes
   `cumulative` from 0 to `txAmount`. Then withdraw `txAmount`. `transfer.circom` treats
   `cumulative` as *spent this epoch*; `withdraw.circom` treats the same slot as *balance*.
   The withdraw change commitment has `cumulative = 0` again, so the loop can be repeated
   (UNMEASURED beyond one cycle).
3. **V3, recipient redirect (E7, already known, still on `main`).** Resubmit someone else's withdraw
   proof with your own `recipient`.

**What they cannot do (bindings that hold, each with a negative test):**
- tamper with `withdrawAmount`;
- replay a withdrawal;
- withdraw an unregistered commitment;
- prove a transfer against a foreign Merkle root, a different threshold, or a stale epoch.

**Residual surface not addressed here:**
- the trusted setup (RR2: a dev ceremony makes forged proofs possible regardless);
- `oldCommitment` linkability (2026-11-14);
- `encrypted_amount` is unbound (queue 2c);
- E8 compliance owner binding (fixed on unmerged #121).

**Assumptions:**
- Groth16 knowledge soundness under the deployed VK.
- Poseidon collision resistance.
- `sui::groth16` is correct.

All three are already assumed by Veil. None of the attacks above weakens them; they live in the
Move glue and in the meaning of the circuit statement.

**STRIDE mapping (`docs/threat-model.md`):**
- **E4** changes from "Mitigated" to **Not mitigated (Critical)**.
- **E7** changes from "Mitigated" to **Not mitigated on `main`**.
- New residual risk **RR10: no value conservation**.
- It also touches **T1/T2**, tampering with pool state, because pool funds are drained.

## Approach

**Mechanical table.** I listed every public-input byte range of the three circuits against the
Move statement that consumes it (`pool.move`, `compliance.move`). I added one more row the circuits
can't see: `deposit_and_register`'s coin amount vs. the commitment.

**Real proofs, not mocks.** `scripts/bench/binding-audit.mjs` builds attack witnesses and proves
them with the repo's own circuits. It checks each proof with `snarkjs.groth16.verify`, then writes
`contracts/tests/binding_audit_fixtures.move` (VKs, proofs, inputs as arkworks bytes, via
`scripts/src/proof-converter.ts`). `contracts/tests/binding_audit_tests.move` replays them through
`sui::groth16` on the unmodified pool. The tamper test aborting with `E_INVALID_WITHDRAW_PROOF`
shows that verification is real in these tests.

**Rejected alternatives:**
- **Localnet harness (2026-11-13 style).** Stronger end-to-end, but it adds a running node, and the
  claim does not depend on gas or networking. `sui move test` is reproducible in CI and runs the
  same verifier.
- **Writing the fix tonight.** A real fix changes the commitment format in all three circuits, the
  frontend and the ceremony. Rushing that would be worse than a precise PARK.

**Characterization tests.** The `vuln_*` tests assert the *current vulnerable* behaviour, so
`sui move test` reproduces the numbers. They stay green while the bug exists, and the fix PR must
invert each one into `#[expected_failure]`. This is documented in the module header. No existing
test was changed.

### Binding table (`main` @ `f942fca`)

| Circuit | Bytes | Public input | On-chain consumer | Bound? | Test |
|---|---|---|---|---|---|
| transfer | 0..32 | oldCommitment | `dynamic_field::remove` (must exist, mature) | ✅ | `bound_withdraw_unregistered_commitment_rejected` (same mechanism) |
| transfer | 32..64 | newCommitment | stored, uniqueness | ✅ | existing `threat_duplicate_commitment_rejected` |
| transfer | 64..96 | threshold | `== pool.threshold`, upper bytes 0 | ✅ | `bound_transfer_threshold_rejected` |
| transfer | 96..128 | epochId | current or previous epoch | ✅ | `bound_transfer_stale_epoch_rejected` |
| transfer | 128..160 | nullifier | uniqueness set | ✅ | existing S3 tests |
| transfer | 160..192 | txAmountHash | **none**: not checked, not emitted | ❌ (no value at stake today; the auditor ciphertext can't be tied to it, queue 2c) | none |
| transfer | 192..224 | merkleRoot | `== pool.commitment_root` | ✅ | `bound_transfer_root_rejected` |
| withdraw | 0..32 | commitment | `dynamic_field::remove` | ✅ | `bound_withdraw_replay_rejected`, `…unregistered…` |
| withdraw | 32..64 | withdrawAmount | amount paid, upper bytes 0 | ✅ as a payout; ❌ as *value* (V1, V2) | `bound_withdraw_amount_tamper_rejected`, `vuln_forged_deposit_withdraws_10x`, `vuln_transfer_inflates_withdrawable_balance` |
| withdraw | 64..96 | nullifier | uniqueness set | ✅ | `bound_withdraw_replay_rejected` |
| withdraw | 96..128 | recipientHash | **none** | ❌ **(E7)** | `vuln_withdraw_recipient_not_bound` |
| withdraw | 128..160 | newCommitment | stored, uniqueness | ✅ | none |
| compliance | 0..32 | merkleRoot | `== config.credential_root` | ✅ | existing |
| compliance | 32..64 | currentEpoch | current or previous | ✅ | existing |
| compliance | 64..96 | contextId | **none** | ❌ (E8, fix unmerged in #121) | in #121 |
| compliance | 96..128 | requiredKycLevel | `>= config.required_kyc_level` | ✅ | existing |
| compliance | 128..160 | nullifier | uniqueness set | ✅ | existing |
| compliance | 160..192 | validCredential | `== 1` | ✅ | existing |
| *deposit* | none | coin amount ↔ commitment | **none** | ❌ **(V1)** | `vuln_forged_deposit_withdraws_10x` |

**Totals:**
- 18 circuit public inputs: **15 bound, 3 unbound** (txAmountHash, recipientHash, contextId).
- Plus one unbound relation outside the circuits: deposit value ↔ commitment.
- Two of the four gaps move money: V1/V2 and E7.

## Results

| Metric | Expected (hypothesis) | Measured on `main` |
|---|---|---|
| V1: TOKEN out / TOKEN in (forged deposit) | ≤ 1 | **10.0** (1000 / 100) |
| V2: TOKEN out / TOKEN in (genesis + 1 transfer, no forgery) | ≤ 1 | **10.0** (1000 / 100) |
| V3: withdraw paid to an address the proof did not commit to | rejected | **paid** (100 TOKEN to `0xF`) |
| Honest exit: can a frontend-format depositor withdraw their own 100 TOKEN? | yes | **no**: witness rejected at `withdraw.circom:84` (C5) |
| Victim funds lost per attack (pool 2100 → 1100 TOKEN) | 0 | **900 TOKEN** |
| Unbound public inputs (of 18) | 0 | **3** |
| Move suite | 124 pass | **133 pass** (124 + 9 new) |
| Proving cost of the attacks | none | withdraw 310–660 ms, transfer 1015 ms (Node, dev zkey) |

The 10× figure is the scenario size I chose. The real bound is `min(pool balance, 2^64−1)` for V1
and `threshold` per cycle for V2.

### Raw output

Toolchain:
- `sui 1.72.1-94ad8ccd0ed6` (prebuilt `testnet-v1.72.1`)
- `circom compiler 2.2.2` (prebuilt release binary)
- snarkjs 0.7.6, Node v22.23.4
- a local dev pot15 (the Hermez URL is 403 here), generated with the commands in the
  `scripts/bench/build-circuit.sh` header in 7 m 28 s

Circuit builds reproduce the baseline: transfer 13,611 constraints, compliance 12,743,
withdraw 3,058.

```
$ node --experimental-strip-types --no-warnings scripts/bench/binding-audit.mjs --move-out contracts/tests/binding_audit_fixtures.move
[A forged-deposit] fullProve 660.5 ms, snarkjs verify = true
[A forged-deposit] publicSignals = ["4400733801425150772419691137767719921705830800429700574495874659046581099614","1000000000","20771156773174687639657471065375993405425865192066875052841861622706086172777","17435674191248485265183296413827091600829972529513151407378200081958798474667","6786372214941832908952685717131197341565203974540057267144293014501945540801"]
[B redirect] fullProve 312.0 ms, snarkjs verify = true
[B redirect] publicSignals = ["3273693400920902937012178654756069692589759753575927969818154774628869160284","100000000","1066195669841891170943786653493882299496716865335180662422901910706091633821","12100168156318835020515280028649222243456145712674370737751199725595830897787","11656073519426541757394692766488772002257078764399486616625594923877048151655"]
[D transfer] fullProve 1015.0 ms, snarkjs verify = true
[D transfer] publicSignals = ["14237068659769433888759346124840080031780595479447271242316671296844753916687","15645041139936657814434511710295850580897976570523216262151836101792975597090","1000000000","1","6296049270738437766755304416105311413788053695751690143239766407813203138085","2290996981174697403703996559301962619835612441211855654749123835436167949888","16528302833757331356773874927541134479532376042262518268933594344594345963084"]
[D withdraw-after-transfer] fullProve 334.4 ms, snarkjs verify = true
[D withdraw-after-transfer] publicSignals = ["15645041139936657814434511710295850580897976570523216262151836101792975597090","1000000000","13928598078857834591990430635155557553579204950476038680953593569778349455141","11612205322485963557273079857927327680809958590634739588958011540515822798674","14004259920946648626412927360321853270047514874515026586928004783502477868599"]
ERROR:  4 Error in template Withdraw_149 line: 84

[C honest-exit] witness generation REJECTED: Error: Assert Failed. Error in template Withdraw_149 line: 84
[C honest-exit] honest depositor can withdraw own 100 TOKEN from genesis commitment: false
wrote contracts/tests/binding_audit_fixtures.move
```
(The long signal lists are shortened with `...` only in this report. The script prints them in full.)

```
$ cd contracts && sui move test binding_audit
[ PASS    ] veil::binding_audit_tests::bound_transfer_root_rejected
[ PASS    ] veil::binding_audit_tests::bound_transfer_stale_epoch_rejected
[ PASS    ] veil::binding_audit_tests::bound_transfer_threshold_rejected
[ PASS    ] veil::binding_audit_tests::bound_withdraw_amount_tamper_rejected
[ PASS    ] veil::binding_audit_tests::bound_withdraw_replay_rejected
[ PASS    ] veil::binding_audit_tests::bound_withdraw_unregistered_commitment_rejected
[ PASS    ] veil::binding_audit_tests::vuln_forged_deposit_withdraws_10x
[ PASS    ] veil::binding_audit_tests::vuln_transfer_inflates_withdrawable_balance
[ PASS    ] veil::binding_audit_tests::vuln_withdraw_recipient_not_bound
Test result: OK. Total tests: 9; passed: 9; failed: 0

$ cd contracts && sui move test
Test result: OK. Total tests: 133; passed: 133; failed: 0
```

How the numbers are asserted:
- `vuln_forged_deposit_withdraws_10x`: `got == 1000 * TOKEN_UNIT`, `got == 10 * (100 * TOKEN_UNIT)`,
  pool `2100 → 1100` TOKEN.
- `vuln_transfer_inflates_withdrawable_balance`: the same three assertions, plus the pool balance
  staying unchanged across the `shielded_transfer`.

FULL_SUITE_PLACEHOLDER

## Verdict

**KEEP (audit) / PARK (fix).**
- What merges: the table, the harness and the tests. They are permanent regression fixtures for
  whoever fixes V1/V2/E7.
- What doesn't: the fix. It needs a new commitment shape across all three circuits plus a fresh
  ceremony, and should not be rushed.
- `BASELINE.md` gains a security-invariants section.
- `threat-model.md` E4/E7 are corrected and RR10 is added.

## Where this could be used

- **Any "compliance-first" shielded pool that reuses one commitment slot for two meanings.** For
  example, a spending-limit counter and a balance. This applies to Privacy-Pools-style designs that
  bolt a rate limit onto a note. The audit pattern catches the bug class mechanically: list each
  public input, its on-chain consumer, and the *meaning* both sides assume.
- **Sui Move + Groth16 apps in general**, because `sui::groth16` returns a bool over opaque bytes.
  Every app has to re-bind the inputs by hand: zkLogin-adjacent custom verifiers, private voting,
  private airdrop claims. `binding-audit.mjs` plus Move fixtures is a reusable template for
  real-proof Move unit tests without a localnet.
- **Thesis chapter:** "Soundness beyond the circuit: statement-level bugs in deployed ZK
  applications". V2 is a clean example of a sound circuit (C1–C11 all hold) composed into an unsound
  protocol.

## Open questions → queue

1. **Value-conservation redesign (Critical, top).** Proposed shape:
   - **Commitment:** `Poseidon(1, balance, spentThisEpoch, epoch, r, s)`.
   - **Deposit:** bind it with a small deposit proof that the commitment opens to the public
     `coin.value()`. An alternative is computing `Poseidon(1, amount, inner)` on-chain with
     `sui::poseidon`, where `inner = Poseidon(r, s, …)`.
   - **Transfer:** conserve `balance` and increment only the counter. The transfer must also get a
     recipient output, because today it moves no value.
   - **Measure:** constraints, proving time and gas against `BASELINE.md`.
2. **Land E7 (`fdbc193`) and E8 (#121).** Both are written and tested. Owner action.
3. **`txAmountHash` is dead weight.** Bind it to `encrypted_amount` (queue 2c) or drop it from the
   public inputs. It is one of 7 inputs, and every public input costs one G1 scalar mul in
   verification.
4. **Is there any cross-pool replay?** No public input binds a pool ID. It is harmless today
   because commitments are per-pool, but it should be re-checked after the redesign.
5. **Merge policy.** Until nightly PRs are merged or closed, every night must reconstruct state from
   ~115 branches. That is the loop's own bottleneck.
