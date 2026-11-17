# On-chain gas per entry point (localnet, real proofs)

**Date:** 2026-11-17 · **Queue item:** #1 (BASELINE's one missing axis, blocked twice before) ·
**Verdict:** **KEEP** — gas measured for every user-facing entry point; plus **two critical
on-chain binding bugs found by the same harness** (see "Findings").

## Hypothesis

Veil's per-transfer on-chain cost is dominated by Groth16 verification
(`prepare_verifying_key` + pairing check, re-done on every call) — so `shielded_transfer`,
`zk_withdraw` and `compliant_transfer` should cost measurably more computation gas than the
non-verifying entry points, and `compliant_transfer` (two verifies) roughly twice `shielded_transfer`.

**Falsified.** All of them, including two-proof `compliant_transfer`, land in Sui's minimum
computation bucket (1,000 units = 1,000,000 MIST at RGP 1,000). The bill is set by **storage**,
not by verification.

## Threat / privacy model

This is a measurement experiment, so the "adversary" is mainly economic. Three are relevant:

- **Griefer / spammer.** Sends transactions that pass the cheap checks and then fail. Observes
  nothing new. What matters is how much a rejected call costs them. Measured: **1,001,044 MIST**
  net for a replayed transfer, and the same for a `zk_withdraw` that runs the full pairing check
  and then aborts. Groth16 verification gives a griefer no extra cost amplification against the
  validator, because the verify is billed in the same bucket as a no-op. The validator's real CPU
  cost per pairing is not reflected in what the griefer pays.
- **Chain observer / mempool front-runner** (STRIDE **E7**). Sees every submitted `zk_withdraw`
  proof and its public inputs before or at inclusion. The bench run showed this adversary can steal
  any withdrawal (Finding 1).
- **Credential lender / non-KYC'd user** (STRIDE **E5**, new **E8**). Holds no credential, or a
  colluding party holds one. The bench run showed the compliance gate does not bind the credential
  to the transfer owner (Finding 2).

**Not defended against, and not measured:**
- Shared-object contention on `Pool` under concurrent transfers. Every entry point takes
  `&mut Pool`, so all Veil transfers are sequenced through consensus on one object. This was a
  single-sender run.
- Gas under the testnet/mainnet protocol config and RGP. Public fullnodes are policy-blocked from
  this sandbox (see Results).
- The validator-side CPU cost of verification. Sui's gas schedule hides it.

**Assumptions:**
- A dev-only trusted setup. This run used a *locally generated* pot15 ptau, because the Hermez
  download URL returned 403 from this sandbox. The VK, proof and public-input *sizes* are identical
  to a Hermez-ptau setup, so gas is unaffected. Correctness also holds (on-chain verification passed).
- Localnet `sui 1.84.0` protocol defaults.
- STRIDE mapping: D2/D3 (spam cost), E5/E7 (now marked open), new E8, RR10, RR11.

## Approach

- **Toolchain unblock.** The previous two blockers were "no `sui` CLI" and "JSON-RPC denied".
  - GitHub release assets and `fullnode.testnet.sui.io` are still 403 at the egress proxy (verified,
    not retried).
  - `git` clone of `MystenLabs/sui` works, so I built `sui` from source: tag `testnet-v1.84.0`,
    `cargo build --release -p sui --bin sui -j 4`. It took about 25 minutes on 4 cores (clone at 07:02 UTC, binary at 07:27 UTC).
  - I also built circom 2.2.2 from source.
- **New harness `scripts/bench/gas-localnet.ts`.** It runs against `sui start --with-faucet --force-regenesis`.
  - It publishes the package and creates `--rounds` independent pools, each with
    `epoch_duration_ms = 60_000` (the minimum), so timelocks clear in about a minute.
  - Per pool it deposits 5 notes, sets a real 3-leaf commitment Merkle root, proposes the withdraw
    VK, and creates a ComplianceConfig with a real 2-leaf credential tree.
  - It then waits one pool epoch and executes, with real snarkjs Groth16 proofs:
    - `shielded_transfer`
    - a replay of it
    - honest `compliant_transfer`
    - a cross-user compliance probe
    - `zk_withdraw`
    - a mismatched-input `zk_withdraw`
    - a recipient-swap probe
    - freeze, unfreeze and propose-VK admin ops
  - It reports `effects.gasUsed` verbatim.
- **Measuring failed transactions.** The `@mysten/sui` gRPC resolver dry-runs every transaction and
  throws on abort before submission. To measure what a *rejected* transaction really costs, the
  harness resolves only the transaction kind and attaches explicit gas data, so the failing
  transaction is actually executed and charged.
- **Rejected alternatives:**
  - `sui move test --statistics`: the Move unit tests contain no real proofs, so they never exercise
    `sui::groth16` and their gas would be meaningless for the verify path.
  - Historical gas from the deployed testnet package: blocked by policy.
- **Two tooling notes for future nights:**
  - In sui 1.84, localnet's port 9000 is gRPC only. JSON-RPC POSTs return 404, so the harness uses
    `SuiGrpcClient`.
  - snarkjs under bun never resolves with its default worker threads. The process silently exits 0.
    The harness proves with `{ singleThread: true }` and skips the local `groth16.verify`; the
    on-chain verifier is authoritative.

## Results

| Entry point | Computation (MIST) | Units | Storage | Rebate | **Net (MIST)** |
|---|---|---|---|---|---|
| `pool::shielded_transfer` | 1,000,000 | 1,000 | 14,485,600 | 12,736,326 | **2,749,274** |
| `compliance::compliant_transfer` | 1,000,000 | 1,000 | 22,556,800 | 18,450,955 | **5,105,845** |
| `pool::zk_withdraw` | 1,000,000 | 1,000 | 15,823,200 | 12,493,151 | **4,330,049** |
| `pool::deposit_and_register` | 1,000,000 | 1,000 | 10,358,800 | 8,305,969 | **3,052,831** |
| rejected replay (`E_COMMITMENT_CHAIN_BROKEN`) | 1,000,000 | 1,000 | 10,442,400 | 10,441,356 | **1,001,044** |
| rejected bad proof (`E_INVALID_WITHDRAW_PROOF`) | 1,000,000 | 1,000 | 10,442,400 | 10,441,356 | **1,001,044** |
| admin ops | 1,000,000 | 1,000 | 8.5M–18.2M | | 1.0M–8.5M |
| publish | 1,410,000 | 1,410 | 156,415,600 | 19,758,024 | 138,067,576 |

All rounds were identical: n=3 per entry point, and n=15 for deposits.

What the numbers mean:

- **Verification is free at billing granularity.** `compliant_transfer` does
  2×`prepare_verifying_key` and 2×pairing. Its computation charge equals `freeze_pool`'s, which does
  no crypto. Sui's protocol config prices `groth16_prepare_verifying_key_bn254_cost_base` at 82,010
  *internal* units. That is the "~82K gas" in the `verifier.move` comment that recommends caching a
  `PreparedVerifyingKey`. Internal units are not billed units, though: on this localnet the caching
  optimisation would save **0 MIST** today. Re-measure if Sui's bucket table changes.
- **Storage is the bill.** Every call rewrites the `Pool` object, which holds 488 B of transfer VK,
  424 B of withdraw VK, and pending-update fields; nearly all of that is rebated. The non-rebated
  remainder plus the new dynamic fields is what a user pays:
  - `shielded_transfer` adds 1 nullifier field and 1 commitment field and removes 1, for a net
    ≈2.75M MIST.
  - `compliant_transfer` adds a credential-nullifier field on top. It also emits the encrypted
    amount and rewrites `ComplianceConfig`, for a net ≈5.1M MIST.
  - The rejected-call cost (1.0M MIST) is essentially the 1,000-unit computation floor.
- **Size check.** VK bytes on chain are transfer 488, withdraw 424 and compliance 456.

Raw output (`bun run scripts/bench/gas-localnet.ts --rounds 3 --json docs/research/data/2026-11-17-gas-localnet.json`;
every transaction digest is in the JSON):

```
sender 0x126b45d5bb19f508ad43b783dac9af4851c1ed99c683651fa2cdb5021b078a5e, reference gas price 1000 MIST/unit
vk bytes: transfer 488, withdraw 424, compliance 456
waiting for pool epoch 29915019 (timelocks, note maturity)...
epoch 29915019 reached
  !! PROBE compliant_transfer (foreign compliance proof): expected failure but SUCCEEDED
  round 0 binding probe: ACCEPTED (compliance proof not bound to transfer)
  !! PROBE zk_withdraw (recipient swapped): expected failure but SUCCEEDED
  round 0 recipient probe: ACCEPTED (100 units paid to 0x3ca0b5b902c80f4a44e330e347361a20ac273de4112fbfcf26519e923d2a9591, not to the proven recipient)
  !! PROBE compliant_transfer (foreign compliance proof): expected failure but SUCCEEDED
  round 1 binding probe: ACCEPTED (compliance proof not bound to transfer)
  !! PROBE zk_withdraw (recipient swapped): expected failure but SUCCEEDED
  round 1 recipient probe: ACCEPTED (100 units paid to 0xfd6cfa78cfc901ab2ac0d3ca7bfa1e1c1b7ddaac052417498cb12f162435cbb1, not to the proven recipient)
  !! PROBE compliant_transfer (foreign compliance proof): expected failure but SUCCEEDED
  round 2 binding probe: ACCEPTED (compliance proof not bound to transfer)
  !! PROBE zk_withdraw (recipient swapped): expected failure but SUCCEEDED
  round 2 recipient probe: ACCEPTED (100 units paid to 0xd1cf264765f3bab3761009d7dcbbbb43cf02e255d0028c5e717d404f087f095b, not to the proven recipient)

| op | n | status | gas price | computation (MIST) | comp. units | storage (MIST) | rebate (MIST) | net (MIST) |
|---|---|---|---|---|---|---|---|---|
| publish (package) | 1 | success | 1000 | 1410000 | 1410 | 156415600 | 19758024 | 138067576 |
| token_faucet::faucet | 3 | success | 1000 | 1000000 | 1000 | 4043200 | 2705329 | 2337871 |
| pool::create_pool | 3 | success | 1000 | 1000000 | 1000 | 8496800 | 987901 | 8508899 |
| pool::deposit_and_register | 15 | success | 1000 | 1000000 | 1000 | 10358800 | 8305969 | 3052831 |
| pool::update_commitment_root | 3 | success | 1000 | 1000000 | 1000 | 8740000 | 8495950 | 1244050 |
| pool::propose_withdraw_vk | 3 | success | 1000 | 1000000 | 1000 | 11970000 | 8739126 | 4230874 |
| compliance::create_compliance_config | 3 | success | 1000 | 1000000 | 1000 | 18171600 | 11968803 | 7202797 |
| pool::shielded_transfer | 3 | success | 1000 | 1000000 | 1000 | 14485600 | 12736326 | 2749274 |
| REJECTED replay shielded_transfer | 3 | abort: MoveAbort in 1st command, abort code: 9, in '0xd714bb8247d8f6eba52fb28fca | 1000 | 1000000 | 1000 | 10442400 | 10441356 | 1001044 |
| compliance::compliant_transfer | 3 | success | 1000 | 1000000 | 1000 | 22556800 | 18450955 | 5105845 |
| PROBE compliant_transfer (foreign compliance proof) | 3 | success | 1000 | 1000000 | 1000 | 22556800 | 18450955 | 5105845 |
| pool::zk_withdraw | 3 | success | 1000 | 1000000 | 1000 | 15823200 | 12493151 | 4330049 |
| REJECTED zk_withdraw (proof/inputs mismatch) | 3 | abort: MoveAbort in 1st command, abort code: 28, in '0xd714bb8247d8f6eba52fb28fc | 1000 | 1000000 | 1000 | 10442400 | 10441356 | 1001044 |
| PROBE zk_withdraw (recipient swapped) | 3 | success | 1000 | 1000000 | 1000 | 15823200 | 12493151 | 4330049 |
| pool::freeze_pool | 3 | success | 1000 | 1000000 | 1000 | 11970000 | 11968803 | 1001197 |
| pool::unfreeze_pool | 3 | success | 1000 | 1000000 | 1000 | 11970000 | 11968803 | 1001197 |
| pool::propose_vk_update | 3 | success | 1000 | 1000000 | 1000 | 15686400 | 11968803 | 4717597 |
```

Toolchain and suite, all run in this session:

```
$ sui --version                      → sui 1.84.0-9dc25070cf2e
$ circom --version                   → circom compiler 2.2.2
$ (contracts) sui move test          → Test result: OK. Total tests: 124; passed: 124; failed: 0
$ (circuits)  npm test               → 43 passed / 30 passed / 35 passed, 0 failed (real Groth16 proofs)
$ (scripts)   test-converter         → 109 passed, 0 failed
$ (scripts)   test-compliance-utils  → 67 passed, 0 failed
$ (scripts)   fuzz-tests             → ALL 6 PROPERTIES PASSED
$ (frontend)  tsc --noEmit → exit 0 · biome check → exit 0 · vitest → 19 passed (3 files)
$ curl https://fullnode.testnet.sui.io:443  → CONNECT tunnel failed, response 403   (egress policy)
$ curl https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau → 403
```

The re-compiled circuits match `BASELINE.md`: transfer 6,470/7,141, withdraw 1,465/1,593 and
compliance 6,057/6,686 non-linear/linear constraints.

## Findings (not the hypothesis, but the most important output of the night)

Both findings were reproduced 3/3 on localnet, with real proofs and digests in the JSON. Neither is
caught by the 124 Move tests, because the Move tests have no real proofs.

### Finding 1: `zk_withdraw` does not bind the recipient (critical, STRIDE E7 → open, RR10)

- **The gap.** `withdraw.circom` exposes `recipientHash = Poseidon(8, recipient)`.
  `pool::zk_withdraw` pays `recipient: address`, a *separate* argument, and never checks that it
  hashes to public input bytes 96..128. The in-code comment ("changing recipient invalidates the
  Groth16 proof") is false: the proof only commits to the hash, and nothing compares the hash to
  the argument.
- **Probe.** A proof made for recipient = the sender was submitted with a freshly generated
  address. Result: **accepted**, and 100 units were paid to the fresh address.
- **Attack.** Any mempool observer or relayer can copy any pending withdrawal proof and take the
  funds.
- **Fix (next night).** Compute `sui::poseidon::poseidon_bn254(&vector[8, (address as u256) % p])`
  on-chain and assert it equals the public input. Also add a negative Move test with a real proof.

### Finding 2: compliance proof not bound to the transfer (high, new E8, RR11)

- **The gap.** `contextId = Poseidon(6, transferNullifier, userSecret)` with `transferNullifier`
  private. No public value is shared between the compliance proof and the transfer proof.
- **Probe.** User A's transfer was paired with a compliance proof from user B (a different
  `userSecret`) for an unrelated `transferNullifier`. Result: **accepted**.
- **Attack.** One KYC'd user can sell unlimited compliance proofs. Each uses a fresh context, so
  credential nullifiers never collide.
- **Fix direction (needs a circuit change, a soundness argument and a negative test).**
  - The compliance circuit should recompute the transfer nullifier
    `Poseidon(2, userSecret, epochId, randomnessOld)` from private inputs and expose it as a public
    input. Move then asserts it equals transfer input bytes 128..160.
  - This binds the *same* `userSecret` to both proofs.
  - Leakage cost is nil: both proofs already sit in the same transaction, so an observer gains no
    new link.

## Verdict

**KEEP.** `BASELINE.md`'s gas row is filled with measured numbers, and the Move suite (124/124)
was run for the first time in this loop. The verification-dominates hypothesis is **rejected**:
storage dominates.

Security properties changed (E7 and the recipient-binding control are not actually enforced), so
`docs/threat-model.md` is updated with E7 → Open, new E8, RR10 and RR11. No code fix was made
tonight: one experiment per night, and the fixes deserve their own measured PRs with negative
tests.

## Where this could be used

- **Gas modelling for any Groth16-on-Sui protocol.** For example zkLogin-adjacent apps, private
  voting on Sui, and Sui-based mixers or shielded pools. The result "BN254 verify is billed in the
  minimum bucket; optimise *storage*, not pairings" changes what to optimise. Shrink the shared
  object: move VKs into a separate immutable object, so they aren't rewritten and re-charged on
  every transfer.
- **Batching thesis chapter.** Batched/aggregated proofs (queue #3) would save almost nothing in
  *computation* on Sui today. Their value is amortising per-transfer object writes and contention.
  That is a different argument than on EVM, where pairing gas dominates.
- **Audit methodology for dual-proof compliance systems.** Examples are confidential payroll with
  an attested employer credential, or compliant stablecoin pools on Sui. Any design that pairs a
  "membership/KYC" proof with a "spend" proof must share a public binding value. Finding 2 is a
  clean, reproducible example of "two individually sound proofs, jointly unsound statement".

## Open questions → tomorrow's queue

1. Fix Finding 1 (on-chain recipient-hash check) and re-measure the withdraw gas delta. The
   `sui::poseidon` cost may finally leave the 1,000-unit bucket.
2. Fix Finding 2 (public transfer-nullifier binding in `compliance.circom`), with a soundness
   argument, leakage analysis, a negative test and a constraint delta.
3. Does moving VKs out of `Pool` into immutable objects cut net per-transfer MIST? Pool rewrite is
   the dominant storage term.
4. At what point does computation leave the minimum bucket, e.g. batching N verifies in one PTB?
   This gives a real gas floor for queue #3.
5. Shared-object contention on `Pool` under concurrent senders. The harness supports multiple pools
   but not concurrent senders yet.
6. Adapt the harness's real-proof probes into the CI suite. The Move tests are proof-free, so
   proof-dependent invariants are currently untested in CI.
