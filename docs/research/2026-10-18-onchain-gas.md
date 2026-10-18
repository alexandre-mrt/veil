# 2026-10-18 — On-chain gas per entry point (queue item #1) + `zk_withdraw` recipient-binding finding

## Hypothesis

Real Sui gas (computation + storage, in MIST) for every Veil entry point — including the three
Groth16-verifying ones (`shielded_transfer`, `zk_withdraw`, `compliant_transfer`) — can be measured
with real proofs on a local Sui network, and the Groth16 verification itself is a measurable share of
the total (the number that batching, queue item #3, would attack).

**Result: the second half is false.** Computation cost is `1,000,000` MIST (the minimum bucket,
1000 units × reference gas price 1000) for every call including the proof-verifying ones. Storage
dominates. Queue item #3 (batched verification) loses most of its motivation.

## Threat / privacy model

No protocol change tonight; this is a measurement. The adversary relevant to the *finding* below is a
**malicious or compromised relayer / anyone who observes a `zk_withdraw` transaction before it is
finalised** (see `docs/threat-model.md` RR7, and the relayer in `scripts/src/relayer.ts`).

- **What they can do (confirmed, not hypothesised):** take a valid withdraw proof built for
  recipient A and submit it with recipient B. The contract accepts it and pays B.
- **What they observe:** the proof, the public inputs (incl. `recipientHash`), and the `recipient`
  argument. Nothing needs to be guessed.
- **Not defended / residual surface:** this report does not fix it (see Open questions). Until
  fixed, any party that sees a withdraw tx's arguments before execution can redirect the funds.
- **Assumptions:** the probe ran on a local network, single signer; it shows contract acceptance,
  not mempool visibility on mainnet (Sui has no public mempool, but relayers and fullnodes the user
  submits through do see arguments, and the relayer model explicitly places them in the path).
- **STRIDE mapping:** Tampering (T1 says byte modification is rejected — true for the *proof*, not
  for the unbound `recipient` argument) and Elevation of privilege/Spoofing for the relayer role.
  `docs/threat-model.md` updated with RR10.

## Approach

`scripts/bench/gas-localnet.ts` (new, reusable): publishes `contracts/` to a local network
(`sui start --force-regenesis --with-faucet`), then drives create_pool → mint/deposit ×4 →
timelocked root / withdraw-VK / compliance config → (wait one 60 s epoch) → `shielded_transfer` →
`zk_withdraw` → substitution probe → compliance toggle (wait an epoch) → `compliant_transfer` →
freeze/unfreeze, with real snarkjs Groth16 proofs, and records `effects.gasUsed` per transaction.

Rejected: `sui move test --statistics` (its "Gas Used" column is a test-harness budget residue like
`49999995000042`, not Sui gas — not usable); replaying historical testnet gas via JSON-RPC (the
sandbox proxy returns 403 for `fullnode.testnet.sui.io`).

Setup notes / deviations (all affect *artifacts*, not gas):
- Prebuilt `sui` 1.72.1 came from the GitHub release download (the framework rev in `Move.toml` needs
  1.72.x; 1.60.0 fails to compile it). This unblocks the toolchain for future nights.
- The Hermez `.ptau` URL in `circuits/scripts/compile*.sh` now returns 403. I used PSE
  `ppot_0080_15.ptau` (2^15) + `snarkjs powersoftau prepare phase2` (7 min). Constraint counts and
  gas are unaffected; proving keys are not the ones in BASELINE.md's run.
- `bun` exits silently inside `snarkjs.groth16.fullProve`; the harness is run with Node (`tsx`).
- circom 2.2.2 built from `iden3/circom` as in the 2026-07-22 run.

## Results

Environment: Sui 1.72.1 local network, reference gas price 1000 MIST/unit, pool `epoch_duration_ms`
= 60,000. All values MIST, from `effects.gasUsed`; `net = computation + storage − rebate`.
Raw JSON: `docs/research/data/2026-10-18-gas-localnet.json`.

| Entry point | Computation | Storage cost | Storage rebate | Net |
|---|---|---|---|---|
| publish (whole package) | 1,380,000 | 156,415,600 | 4,890,600 | 152,905,000 |
| create_pool | 1,000,000 | 8,496,800 | 978,120 | 8,518,680 |
| token_mint (test token) | 1,000,000 | 4,043,200 | 2,678,544 | 2,364,656 |
| deposit_and_register | 1,000,000 | 9,021,200 | 8,223,732 | 1,797,468 |
| update_commitment_root (propose) | 1,000,000 | 8,740,000 | 8,411,832 | 1,328,168 |
| propose_withdraw_vk | 1,000,000 | 11,970,000 | 8,652,600 | 4,317,400 |
| create_compliance_config | 1,000,000 | 18,414,800 | 11,850,300 | 7,564,500 |
| **shielded_transfer** | 1,000,000 | 14,485,600 | 12,610,224 | **2,875,376** |
| **zk_withdraw** | 1,000,000 | 15,823,200 | 12,369,456 | **4,453,744** |
| **compliant_transfer** (2 proofs) | 1,000,000 | 22,800,000 | 18,516,564 | **5,283,436** |
| propose_compliance_toggle | 1,000,000 | 11,977,600 | 11,850,300 | 1,127,300 |
| freeze_pool / unfreeze_pool | 1,000,000 | 11,970,000 | 11,850,300 | 1,119,700 |

Reading it:
- Computation is the **minimum bucket in every row** (except publish, 1.38M). Verifying one Groth16
  proof (7 public inputs), or two (compliant_transfer), does not move a tx out of the lowest
  computation tier. Caveat: Sui buckets computation, so a sub-bucket difference is invisible here;
  this bounds verification cost above by "less than one bucket step", it does not give its exact
  size.
- Cost is storage (inferred from the code, not separately profiled): a transfer mutates the shared
  `Pool` object and removes/adds dynamic fields for the old commitment, nullifier and new commitment. Net per private transfer ≈ 2.9M MIST
  ≈ 0.0029 SUI at RGP 1000; compliant transfer ≈ 5.3M MIST.
- Move tests: `Test result: OK. Total tests: 124; passed: 124; failed: 0` (`sui move test`, 1.72.1).
- Probe: `# recipient-substitution probe accepted on-chain: true` — the second `zk_withdraw` row in
  the JSON is a proof generated for recipient `0x…abcdef123456` submitted with recipient
  `0x…badbadbad000`, status `success`. (An earlier run of the probe aborted with code 10,
  `E_COMMITMENT_EXISTS` — a flaw in the probe (identical change commitment), after the proof check
  had passed; fixed by using different change randomness. Both runs are in the branch history.)
- Not measured: mainnet/testnet RGP (differs from 1000), contention under concurrent transfers on
  the shared `Pool`, gas growth as dynamic fields accumulate (only the first few entries were
  inserted).

Reproduce (≈5 min incl. two 60 s epoch waits): start `sui start --force-regenesis --with-faucet`,
compile the circuits, then `cd scripts && GAS_OUT=gas.json npx tsx bench/gas-localnet.ts`.

## Verdict: **KEEP** (gas axis closed) — plus a **security finding**

- Gas: measured; `BASELINE.md` updated.
- `zk_withdraw` does not bind its `recipient` argument to the proof's `recipientHash`
  (`pool.move` ~L596–L600: the comment asserts "changing recipient invalidates the Groth16 proof";
  nothing in the contract computes or compares the hash). Confirmed on a local network. Not fixed in
  this PR: the fix touches contract + possibly frontend/relayer and needs its own soundness argument
  and negative test, so it is queue item #1.

## Where this could be used

- Any Sui ZK application budgeting per-action cost: the finding that Groth16 verify is within the
  minimum computation bucket while shared-object rewrites dominate applies to e.g. a confidential
  payroll on Sui with a t-of-n auditor board (each pay run = N compliant transfers ≈ N × 5.3M MIST
  of mostly storage) — the optimisation target is object layout (per-commitment dynamic fields vs.
  batched Merkle appends — a hypothesis, not tested here), not proof aggregation.
- The recipient-binding bug class applies to every "proof + relayer" design (Tornado-style
  withdraw on any chain): the withdrawal address must be a public input *and* checked on-chain.
  Thesis chapter: relayer threat model / front-running resistance.

## Open questions (→ queue)

1. **Fix recipient binding.** Options: (a) compute `sui::poseidon::poseidon_bn254([8, recipient_as_field])`
   on-chain and compare with `recipientHash` (needs a defined address→field reduction since a Sui
   address is 256 bits > BN254 r, and the circuit input must use the same reduction); (b) pass the
   recipient as a public input and compare bytes. Needs circuit/contract/relayer/frontend
   changes, a negative test (this probe becomes the regression test), and a Move test.
2. Does `compliant_transfer` bind the compliance proof's `contextId` to the transfer's nullifier
   on-chain? The contract passes both proofs but I found no check linking them (read only, not
   tested) — a compliance proof could be reused with an unrelated transfer.
3. Gas growth with pool size / contention on the shared `Pool` under concurrent transfers.
4. `scripts/src/e2e-test.ts` calls `create_pool` with 2 args; the contract takes 3 — stale.
5. Item #3 (batched verification) should be re-ranked after seeing storage dominate.
