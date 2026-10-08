# 2026-10-08 — On-chain gas per entry point (queue item #1)

## Hypothesis

Real on-chain gas for each Veil entry point (`create_pool`, `deposit_and_register`,
`shielded_transfer`, `zk_withdraw`, admin ops) can be measured by running the actual Move package and
real Groth16 proofs on a local Sui network, and the per-transfer cost is dominated by the Groth16
verification (computation fee) — which is the premise behind queue item #3 (batched verification).
This experiment moves "entry points with a measured gas number" from 0 to 11, and tests the premise.

## Threat / privacy model

Measurement night; no protocol change, so no adversary model changes. Two relevant observations:

- **Chain observer / griefing economics.** Gas is what an attacker pays to spam the pool (e.g. submit
  invalid proofs). A failed `shielded_transfer` still costs the sender computation + storage, so the
  measured floor below is the per-attempt DoS price on the *sender* side. It says nothing about
  shared-object contention (not measured).
- **Residual surface (not defended / not measured):** localnet gas parameters can differ from
  testnet/mainnet (reference gas price, storage price). Numbers below are in MIST at localnet
  reference gas price 1000; computation is bucketed so it cannot resolve finer than the floor.
- Assumptions: unchanged (dev-only single-contributor setup, RR2 in `docs/threat-model.md`). The
  Powers of Tau file used here was generated locally (see Approach) — irrelevant to gas, but it means
  zkeys from this run must not be compared to the 2026-07-22 size/time numbers.

STRIDE mapping: none directly; informs a future DoS/griefing entry.

## Approach

Unblocking the toolchain took most of the run (this is the third night gas was queued):

1. `sui` CLI: the `MystenLabs/sui` GitHub **release** tarball is reachable through the egress proxy even
   though `fullnode.*.sui.io` is not. First try, `testnet-v1.60.0`, could not compile the pinned
   framework (`internal::Permit` unresolved) — the pinned rev in `contracts/Move.toml`
   (`94ad8ccd…`) is tag `testnet-v1.72.1`, so that exact release was used: `sui 1.72.1-94ad8ccd0ed6`.
2. `sui move test`: **124/124 pass** (closes the "NOT RUN" row in BASELINE).
3. `circom` 2.2.2 built from source; circuits compiled with the repo's `compile*.sh`. The Hermez
   Powers of Tau download (`storage.googleapis.com/zkevm/...`, and the S3 mirror) is now denied
   (`AccessDenied` / proxy 403), so a pot15 file was generated locally
   (`snarkjs powersoftau new bn128 15` → contribute → `prepare phase2`, 8m41s). Dev-only, same trust
   level as the existing single-contributor zkey step.
4. `sui start --force-regenesis --with-faucet` (localnet), then `scripts/bench/onchain-gas.ts`:
   publishes the package, creates a pool, mints/deposits two genesis commitments, schedules the
   commitment root and withdraw VK (1-epoch timelock, `EPOCH_MS` = 60 s minimum), waits for the pool
   epoch to roll over, then submits a **real** `shielded_transfer` proof (new `epochId` parameter added
   to `buildTransferWitness`) and a real `zk_withdraw` proof, plus a replayed (aborting) transfer and
   freeze/unfreeze.

Rejected: `sui client publish`/`sui move build --dump-bytecode-as-base64` (the latter's tree-shaking
step calls a public fullnode, blocked → used `--no-tree-shaking`); `sui move test --statistics`
(reports test-VM instruction counts, not charged gas); estimating from Sui's gas schedule (the rule:
only measured numbers).

## Results

Gas in MIST (1 SUI = 10⁹ MIST), localnet, reference gas price 1000. `net = computation + storage − rebate`.

=== SUMMARY (MIST) ===
┌─────────┬─────────────────────────────────────────────────────────┬─────────────┬───────────┬──────────┬───────────┐
│ (index) │ op                                                      │ computation │ storage   │ rebate   │ net       │
├─────────┼─────────────────────────────────────────────────────────┼─────────────┼───────────┼──────────┼───────────┤
│ 0       │ 'publish'                                               │ 1390000     │ 156415600 │ 9781200  │ 148024400 │
│ 1       │ 'create_pool'                                           │ 1000000     │ 8496800   │ 978120   │ 8518680   │
│ 2       │ 'token::mint x2 (not a Veil entry point)'               │ 1000000     │ 5380800   │ 2678544  │ 3702256   │
│ 3       │ 'deposit_and_register (1st, 100 TOKEN)'                 │ 1000000     │ 9021200   │ 8223732  │ 1797468   │
│ 4       │ 'deposit_and_register (2nd)'                            │ 1000000     │ 9021200   │ 8223732  │ 1797468   │
│ 5       │ 'update_commitment_root'                                │ 1000000     │ 8740000   │ 8411832  │ 1328168   │
│ 6       │ 'propose_withdraw_vk'                                   │ 1000000     │ 11970000  │ 8652600  │ 4317400   │
│ 7       │ 'shielded_transfer (1 Groth16 verify, 7 public inputs)' │ 1000000     │ 14242400  │ 12369456 │ 2872944   │
│ 8       │ 'zk_withdraw (1 Groth16 verify, 5 public inputs)'       │ 1000000     │ 15580000  │ 12128688 │ 4451312   │
│ 9       │ 'shielded_transfer replay (aborts after proof verify)'  │ 1000000     │ 10199200  │ 10097208 │ 1101992   │
│ 10      │ 'freeze_pool'                                           │ 1000000     │ 11726800  │ 11609532 │ 1117268   │
│ 11      │ 'unfreeze_pool'                                         │ 1000000     │ 11726800  │ 11609532 │ 1117268   │
└─────────┴─────────────────────────────────────────────────────────┴─────────────┴───────────┴──────────┴───────────┘

Raw output (`node --experimental-strip-types scripts/bench/onchain-gas.ts --sui <sui-1.72.1>`):

```
=== Veil on-chain gas bench === rpc=http://127.0.0.1:9000 sui=sui 1.72.1-94ad8ccd0ed6
reference gas price: 1000
[gas] publish: {"computationCost":"1390000","storageCost":"156415600","storageRebate":"9781200","nonRefundableStorageFee":"98800"} status=success
transfer VK on-chain bytes: 488, withdraw VK bytes: 424
[gas] create_pool: {"computationCost":"1000000","storageCost":"8496800","storageRebate":"978120","nonRefundableStorageFee":"9880"} status=success
[gas] token::mint x2 (not a Veil entry point): {"computationCost":"1000000","storageCost":"5380800","storageRebate":"2678544","nonRefundableStorageFee":"27056"} status=success
[gas] deposit_and_register (1st, 100 TOKEN): {"computationCost":"1000000","storageCost":"9021200","storageRebate":"8223732","nonRefundableStorageFee":"83068"} status=success
[gas] deposit_and_register (2nd): {"computationCost":"1000000","storageCost":"9021200","storageRebate":"8223732","nonRefundableStorageFee":"83068"} status=success
[gas] update_commitment_root: {"computationCost":"1000000","storageCost":"8740000","storageRebate":"8411832","nonRefundableStorageFee":"84968"} status=success
[gas] propose_withdraw_vk: {"computationCost":"1000000","storageCost":"11970000","storageRebate":"8652600","nonRefundableStorageFee":"87400"} status=success
waiting 30.5s for pool epoch rollover...
[gas] shielded_transfer (1 Groth16 verify, 7 public inputs): {"computationCost":"1000000","storageCost":"14242400","storageRebate":"12369456","nonRefundableStorageFee":"124944"} status=success
[gas] zk_withdraw (1 Groth16 verify, 5 public inputs): {"computationCost":"1000000","storageCost":"15580000","storageRebate":"12128688","nonRefundableStorageFee":"122512"} status=success
[finding-check] zk_withdraw to an address NOT bound by the proof's recipientHash succeeded; recipient token balance = 100
[gas] shielded_transfer replay (aborts after proof verify): {"computationCost":"1000000","storageCost":"10199200","storageRebate":"10097208","nonRefundableStorageFee":"101992"} status=failure
[gas] freeze_pool: {"computationCost":"1000000","storageCost":"11726800","storageRebate":"11609532","nonRefundableStorageFee":"117268"} status=success
[gas] unfreeze_pool: {"computationCost":"1000000","storageCost":"11726800","storageRebate":"11609532","nonRefundableStorageFee":"117268"} status=success
=== SUMMARY (MIST) ===
```

Derived:

| Entry point | Computation | Net total | Notes |
|---|---|---|---|
| `deposit_and_register` | 1,000,000 | 1,797,468 | |
| `shielded_transfer` (real proof) | 1,000,000 | 2,872,944 | ≈0.0029 SUI |
| `zk_withdraw` (real proof) | 1,000,000 | 4,451,312 | + creates change commitment, pays coin |
| `shielded_transfer` aborting (replay) | 1,000,000 | 1,101,992 | failed tx still pays |
| `freeze_pool` / `unfreeze_pool` | 1,000,000 | 1,117,268 | |
| `update_commitment_root` | 1,000,000 | 1,328,168 | |
| `propose_withdraw_vk` | 1,000,000 | 4,317,400 | stores 424 B VK |
| `create_pool` | 1,000,000 | 8,518,680 | stores 488 B VK |
| `publish` | 1,390,000 | 148,024,400 | one-off, 156 M storage |

**Premise test — verdict on the hypothesis: refuted.** `computationCost` is exactly 1,000,000 MIST
(1000 units × price 1000, the lowest gas bucket) for *every* transaction, including the two that
verify a Groth16 proof and the one that aborts right after verifying. Groth16 verification therefore
fits inside the minimum computation bucket; gas is dominated by **storage** (dynamic fields for
commitment/nullifier). A transfer's net cost is 2.87 M MIST of which 1.0 M is the computation floor
that any transaction pays; proof verification adds nothing measurable above that floor. Caveat: the
bucket floor hides the true verification cost, so this shows "≤ one bucket", not "zero".

## Verdict

**KEEP** (measurement). `BASELINE.md` gas row and Move-test row updated. Consequence for the queue:
item #3 (batched/aggregated verification) loses its premise — aggregating N proofs cannot save
computation fees below the 1,000,000 MIST floor per tx, and the storage writes (one nullifier + one
commitment per transfer) are not reduced by aggregation. Demoted.

### Finding (not the experiment — noticed while building the withdraw call)

`pool::zk_withdraw` takes `recipient: address` as a free argument and never relates it to the proof's
`recipientHash` public input (bytes 96–128 are never read; the comment in `pool.move:595-599` claims
"changing recipient invalidates the Groth16 proof", which is false since the address is not a public
input). The bench proves it on-chain: the witness's recipient is `0xABCDEF123456`, the call used a
fresh unrelated address, the transaction succeeded and that address received the tokens
(`[finding-check] … recipient token balance = 100`). Impact: a front-runner / malicious relayer who
sees a withdrawal in the mempool or relayer queue can redirect the funds to themselves. **Not fixed
tonight** (contract change + new circuit-public-input check needs its own experiment; Sui has
`sui::poseidon`, so an on-chain `Poseidon(8, recipient)` check is plausible). Queued as item #1 in
the re-ranked list and is a candidate STRIDE entry (Tampering/Elevation) for `docs/threat-model.md`.

## Where this could be used

- Any Sui app that verifies Groth16 on-chain (private payments, zk-KYC gates, zk-airdrop claims):
  "verification fits in the minimum computation bucket" means per-claim cost is storage design, not
  proof size — relevant for a thesis chapter on cost models of on-chain ZK verification on
  object-centric chains.
- A withdraw-recipient binding check is relevant to every ZK pool with relayers (Tornado-style
  `withdraw(recipient, relayer, fee)` public-input binding) — worth a short "common pitfall" section.
- Confidential payroll on Sui with a t-of-n auditor board: per-payment cost ≈ 2.9 M MIST net means
  payroll for N employees is linear in N storage writes; use this table as the cost input.

## Open questions

1. Fix and test the `zk_withdraw` recipient binding (on-chain `sui::poseidon` check vs. making the
   address a field-element public input); add a negative Move test + localnet test.
2. How much of the computation floor is Groth16 really? Use `sui client dry-run`/gas profiler or a
   `--gas-price` / heavier-computation probe to find the true instruction cost.
3. Storage dominates: can nullifier/commitment dynamic fields be made cheaper (e.g. bitmap/bucketed
   storage, or an epoch-pruned set) given storage rebate on spent commitments?
4. Shared-object contention on `Pool` under concurrent transfers (still unmeasured; every transfer
   mutates the one shared `Pool`).
5. Compliance (`compliant_transfer`, two proofs) gas was not measured tonight — needs config + credential
   tree setup; extend `onchain-gas.ts`.
6. Re-measure on testnet when fullnode egress is permitted, to confirm localnet gas parameters.
