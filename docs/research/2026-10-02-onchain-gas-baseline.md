# 2026-10-02 — On-chain gas baseline (queue item #1) + a withdrawal-binding finding

## Hypothesis

Every Veil entry point — `deposit_and_register`, `shielded_transfer`, `compliant_transfer`,
`zk_withdraw` and the admin ops — can be executed end to end with **real Groth16 proofs** on a Sui
network, and the per-entry-point gas read from the chain's own effects; and the raw cost of one
Groth16 verification (and what a pre-prepared VK would save) can be recovered from those effects.
This moves "Veil metrics backed by a real command run" from 11 (2026-07-22) to include the one axis
left BLOCKED then: on-chain gas. It is a measurement night: **no circuit, Move module or frontend
code changed.**

## Threat / privacy model

No protocol change, so no adversary model changes by design. Two things are relevant:

- **Economic adversary (spam / griefing).** Gas is what an attacker pays to submit junk proofs and
  what an honest user pays to transfer. Results below bound both.
- **The measurement turned up a security finding** (see *Finding F1*): the withdrawal flow does not
  bind the proof to the recipient on-chain. Adversary: **a colluding relayer, or anyone who can see a
  withdrawal transaction before it executes** (relayer, fullnode, validator, mempool-style observer),
  who can take a user's real `zk_withdraw` proof and resubmit it with *their own* `recipient`
  address.
  - *Can do:* redirect the whole `withdrawAmount` of any honest user's withdrawal to themselves.
  - *Observes:* the proof, the public inputs, the intended `recipient` (it is a tx argument).
  - *Does NOT defend against / residual:* nothing is defended here — this is an **unmitigated**
    threat that `docs/threat-model.md` E7 listed as Mitigated.
  - *Assumptions in play:* Groth16 soundness (fine); the claim "changing `recipient` invalidates the
    proof" (**false**, see F1).
  - *STRIDE mapping:* Elevation of privilege / Tampering — E7 (front-run ZK withdrawal). E7's status
    is changed to **Unmitigated** in this PR.

Gas measurements themselves have no privacy surface (all fields measured are public tx effects).

## Approach

1. **Unblock the toolchain (the queue's explicit advice).** The two earlier blockers were "no `sui`
   binary" and "JSON-RPC to a public fullnode denied". Tonight: the sandbox's egress policy still
   blocks `fullnode.testnet.sui.io` (HTTP 403 on CONNECT), but `github.com/MystenLabs/sui/releases`
   is reachable, so the **prebuilt `sui` 1.81.0 binary** was downloaded and used to run a **local
   single-validator network** (`sui start --force-regenesis`). This is a real Sui execution
   environment with the same Move VM, the same native Groth16 verifier and the same gas schedule as
   the protocol version it was built from; it is *not* testnet/mainnet. Reference gas price on
   localnet is 1000 MIST; mainnet's differs, so results are reported in **gas units**
   (`computationCost / RGP`) and in MIST at RGP = 1000.
2. **`scripts/bench/gas-bench.ts`** — publishes the real package, creates a pool with the real
   transfer VK, registers the withdraw VK and a compliance config with the real VKs, deposits 7
   commitments (3 `shielded_transfer`, 2 `compliant_transfer`, 2 `zk_withdraw`), builds a real depth-20
   Merkle tree over the transfer commitments, waits out the 1-epoch timelocks (60 s minimum epoch), then
   generates real proofs with snarkjs and submits them. Also records one invalid-proof abort and the admin
   ops.
3. **`scripts/bench/gas-probe.ts` + `scripts/bench/gas-probe-move/`** — a measurement-only Move
   package that repeats one Groth16 primitive `n` times in a single transaction. The chain charges
   computation in buckets, so the probe finds the `n` at which the charge crosses 1000 → 5000 units
   (`n1`, `n2`) and infers cost per call as `4000 / (n2 − n1)` (the unknown fixed base cancels). A
   second, independent estimate is the two-point slope `(u(2·n2) − u(n2)) / n2`. Both are printed.
4. **Rejected alternatives:** (a) `suix_queryTransactionBlocks` against the deployed testnet package
   — host blocked by the egress policy; (b) `sui move test` gas — measures VM instructions, not the
   on-chain charge; (c) building `sui` from source — prebuilt binary made it unnecessary.

**Deviations from the 2026-07-22 setup (stated, not hidden):** the Hermez `powersOfTau28_hez_final_15.ptau`
download URL now returns 403, so a **fresh local `pot15` was generated** (`snarkjs powersoftau new
bn128 15` + 1 contribution + `prepare phase2`). Constraint counts, VK/proof sizes and verification gas
do not depend on the ptau contents, so the on-chain numbers are unaffected; but **proving times were
not re-measured** and the BASELINE.md proving-time rows still refer to the Hermez ptau run. All
zkeys here are dev-only single-contributor (as before).

## Results

Environment: `sui 1.81.0-bf0c491c17b8` localnet, RGP 1000, Node 22.22.0, snarkjs 0.7.6,
circom 2.2.2 (built from source, tag `v2.2.2`). Reproduce:

```
# terminal 1
sui start --force-regenesis --with-faucet --committee-size 1
# terminal 2 (repo root; circuits compiled per scripts/bench/prove-latency.mjs header; bun install in scripts/)
node scripts/bench/gas-bench.ts --json out.json     # ~5 min wall-clock (epoch timelocks)
node scripts/bench/gas-probe.ts --json probe.json   # ~10 min
```

(`bun run` crashes inside snarkjs's worker threads on this machine — Bun 1.3.14 — so the scripts are
run with Node ≥ 22.6, which strips TypeScript types natively.)

### Gas per entry point (`gas-bench.ts`; MIST at RGP 1000; `net = computation + storage − rebate`)

| Entry point | Computation (units) | Storage cost | Storage rebate | Net MIST | Net SUI |
|---|---|---|---|---|---|
| `publish` (6 modules) | 1,390 | 156,415,600 | 9,781,200 | 148,024,400 | 0.148 |
| `create_pool` | 1,000 | 8,496,800 | 978,120 | 8,518,680 | 0.0085 |
| `propose_withdraw_vk` | 1,000 | 11,726,800 | 8,411,832 | 4,314,968 | 0.0043 |
| `create_compliance_config` | 1,000 | 17,928,400 | 11,609,532 | 7,318,868 | 0.0073 |
| `deposit_and_register` (×7, all identical) | 1,000 | 12,494,400 | 11,662,200 | **1,832,200** | 0.0018 |
| `update_commitment_root` | 1,000 | 12,213,200 | 11,850,300 | 1,362,900 | 0.0014 |
| `shielded_transfer` (×3) | 1,000 | 14,485,600 | 12,369,456–12,610,224 | **2,875,376–3,116,144** | 0.0029–0.0031 |
| `shielded_transfer`, invalid proof (aborts `E_INVALID_PROOF`=3) | 1,000 | 10,685,600 | 10,578,744 | **1,106,856** | 0.0011 |
| `compliant_transfer` (×2, identical) | 1,000 | 22,556,800 | 18,268,272 | **5,288,528** | 0.0053 |
| `zk_withdraw` (×2, identical) | 1,000 | 15,823,200 | 12,369,456 | **4,453,744** | 0.0045 |
| `freeze_pool` / `unfreeze_pool` | 1,000 | 11,970,000 | 11,850,300 | 1,119,700 | 0.0011 |
| `propose_withdrawal` / `cancel_withdrawal` | 1,000 | 12,274,000 / 11,970,000 | 11,850,300 / 12,151,260 | 1,423,700 / 818,740 | 0.0014 / 0.0008 |

**Headline: every entry point is charged the 1,000-unit computation minimum** — including the ones
that run one or two pairing-based Groth16 verifications. The user-visible cost of a transfer is
dominated by *storage* (net ≈ 2.9–3.1 M MIST of which ≈ 1.0 M is the computation floor), not by
compute.

### Raw Groth16 cost (`gas-probe.ts`; gas units per call)

| Primitive | circuit | crossing estimate | two-point-slope estimate |
|---|---|---|---|
| `prepare_verifying_key` | transfer / withdraw / compliance | 81.6 / 81.6 / 81.6 | 83.9 / 84.1 / 83.9 |
| `verify_groth16_proof` (VK already prepared; incl. parsing proof+inputs) | transfer (7 inputs) | 181.8 | 183.0 |
| | withdraw (5 inputs) | 166.7 | 164.0 |
| | compliance (6 inputs) | 173.9 | 174.5 |
| prepare + verify = what `verifier.move` does today | transfer | 266.7 | 269.5 |
| | withdraw | 235.3 | 247.6 |
| | compliance | 250.0 | 257.5 |

The two methods agree within ~5 %, and `prepare_verifying_key ≈ 82 units` matches the "~82K gas"
note in `contracts/sources/verifier.move` (82 units = 82,000 internal gas). The empty-loop baseline
disagrees between the two methods (0.53 vs 1.05 units/iter) — irrelevant to the Groth16 conclusions
but a reminder these are bucket-inferred, ±5 % numbers, not exact meter readings.

**Inferred, not directly measured** (the 1,000-unit floor hides the total): a `shielded_transfer`
does ≈ 270 units of verification, a `compliant_transfer` (transfer + compliance proofs)
≈ 270 + 255 ≈ 525 units, both plus small dynamic-field work — all evidently below the 1,000 floor,
since both are charged exactly 1,000.

### Finding F1 — `zk_withdraw` does not bind the proof to `recipient` (confirmed on-chain)

`zk_withdraw #1` submits a proof whose public `recipientHash = Poseidon(8, A)` with `recipient = A`.
`zk_withdraw #2` submits a **proof bound to A** with `recipient = B` (an attacker-chosen address).
It **succeeded**, and B received the tokens:

```
  zk_withdraw #2 (SUBSTITUTED recipient)       ok   comp=1000000 (1000 units) storage=15823200 rebate=12369456
  >> substituted-recipient withdraw success; attacker balance = 100
```

Root cause: `contracts/sources/pool.move` `zk_withdraw` only checks `public_inputs_bytes` bytes 0..96
and 128..160; bytes 96..128 (`recipientHash`) are fed to the verifier and then ignored. The in-code
comment ("changing recipient invalidates the Groth16 proof … verified by the proof itself") is wrong:
the circuit proves `recipientHash == Poseidon(8, recipient_private_signal)`, but nothing connects that
private signal to the transaction's `recipient` argument. `docs/threat-model.md` E7 and
`docs/FUTURE_IMPROVEMENTS.md` ("Poseidon(8, recipient) binding to prevent front-running") claim this is
mitigated. Impact: a malicious relayer (or any party that can see the tx before inclusion) can steal
any ZK withdrawal. Not fixed in this PR (see *Open questions*); `threat-model.md` is corrected.

### Test suite (full CI suite, run on the final tree)

```
contracts:  sui move build ok; sui move test -> Test result: OK. Total tests: 124; passed: 124; failed: 0
circuits:   npm test -> transfer 43 passed / compliance 30 passed / withdraw 35 passed, 0 failed
scripts:    test-converter, test-compliance-utils, fuzz-tests -> all passed ("ALL 6 PROPERTIES PASSED")
frontend:   tsc --noEmit exit 0; biome check exit 0; vitest 19 passed (3 files)
```

(The `ERROR: … Error in template Withdraw_149 line: 96` lines in the circuits output are the
expected assertion failures of negative tests such as W33/W34.) Note the 124 Move tests include
`pool_withdraw_tests.move` and none of them catches F1 — the suite never submits a proof with a
mismatched recipient.

### Raw output

Full logs (committed): `data/2026-10-02-gas-bench.log`, `data/2026-10-02-gas-probe.log` and the
`.json` equivalents. Probe summary as printed:

```
=== Veil gas probe (localnet http://127.0.0.1:9000); sui sui 1.81.0-bf0c491c17b8; RGP 1000 ===
-- transfer
  transfer: prepare_verifying_key x n      n1=12 n2=61  crossing: ~81.633 units/call | two-point slope: ~83.934 units/call
  transfer: verify (VK pre-prepared) x n   n1=5 n2=27  crossing: ~181.818 units/call | two-point slope: ~182.963 units/call
  transfer: prepare+verify x n (today)     n1=4 n2=19  crossing: ~266.667 units/call | two-point slope: ~269.474 units/call
-- withdraw
  withdraw: prepare_verifying_key x n      n1=12 n2=61  crossing: ~81.633 units/call | two-point slope: ~84.098 units/call
  withdraw: verify (VK pre-prepared) x n   n1=6 n2=30  crossing: ~166.667 units/call | two-point slope: ~164.000 units/call
  withdraw: prepare+verify x n (today)     n1=4 n2=21  crossing: ~235.294 units/call | two-point slope: ~247.619 units/call
-- compliance
  compliance: prepare_verifying_key x n    n1=12 n2=61  crossing: ~81.633 units/call | two-point slope: ~83.934 units/call
  compliance: verify (VK pre-prepared) x n n1=6 n2=29  crossing: ~173.913 units/call | two-point slope: ~174.483 units/call
  compliance: prepare+verify x n (today)   n1=4 n2=20  crossing: ~250.000 units/call | two-point slope: ~257.500 units/call
```

## Verdict: **KEEP**

The BLOCKED axis from 2026-07-22 is closed: gas per entry point is measured with real proofs
(BASELINE.md updated), the harness is reusable, and the raw verification cost is characterised. Two
consequences, one good, one bad:

- **Queue re-rank.** Compute is *not* what a user pays for. A pre-prepared VK (saves ≈ 82 units per
  proof) or batch verification would remove computation that is currently hidden under the
  1,000-unit floor, so **today they save the user exactly 0 MIST**. Queue item "batched/aggregated
  proof verification" is demoted; a new "storage footprint per transfer" item (the ≈ 14.5 M MIST of
  storage per transfer) replaces it as the real gas lever.
- **F1 is a protocol-level security bug** and goes to the top of the queue.

Limits of this verdict: localnet, not testnet/mainnet (RGP and storage-price parameters should be
re-checked against the live network before quoting USD figures); single validator, so no
shared-object contention data (the pool is one shared object — concurrency is still unmeasured);
`gas-probe` numbers are ±5 % bucket-inferred; the proving-time rows in BASELINE.md were not
re-measured against the locally generated ptau.

## Where this could be used

- **Any Sui protocol that verifies Groth16 on-chain** (private voting, ZK-KYC gates, shielded
  payment pools, zk-rollup bridges): the probe package gives a drop-in way to get the true
  per-verification cost despite Sui's 1,000-unit floor, and the result — ~270 units for a 7-input
  proof, ~82 of which is VK preparation — says that *verification is cheap enough that a design
  can afford several proofs per transaction before it leaves the floor* (≈ 3 full verifications).
  Directly relevant for a **t-of-n auditor board** variant that attaches several proofs to one
  transfer: the budget is about 3 proofs per tx for free.
- **Confidential payroll on Sui**: per-employee payout is a `zk_withdraw` (≈ 0.0045 SUI net at
  RGP 1000), so a 1,000-employee run costs ≈ 4.5 SUI in fees before any batching — storage, not
  verification, dominates, which points batching research at *state* rather than *proofs*.
- **Thesis chapter:** "Cost model of on-chain ZK verification under floor-priced gas" — the
  floor/bucket effect is general to Sui and rarely documented; and "binding public inputs to
  transaction context" (F1) is a reusable lesson/case study for contract–circuit interface bugs
  that circuit-only test suites cannot see.

## Open questions (tomorrow's queue)

1. **Fix F1** and measure the fix: recompute `Poseidon(8, recipient)` on-chain with
   `sui::poseidon::poseidon_bn254` (or move `recipient` into a public input and compare), add the
   missing negative Move test (proof for A submitted with recipient B must abort), decide the
   address → field mapping (addresses are 256-bit, the field is ~254-bit). Measure the extra gas — is
   it still under the 1,000-unit floor?
2. **Contract ↔ circuit binding audit.** F1 slipped past circuit tests *and* 124 Move tests. Sweep
   every public input of the three circuits and check each is either compared on-chain or provably
   unnecessary (e.g. `txAmountHash`, `recipientHash`, `contextId`; also is `compliant_transfer`'s
   compliance proof actually bound to the transfer proof it accompanies? `contextId` is private in the
   compliance circuit and the contract never relates the two proofs).
3. **What exactly makes up the ≈ 14.5 M MIST transfer storage cost** (two dynamic fields added, one
   removed, gas-coin mutation) and can a design (e.g. nullifier-only set, commitments as Merkle
   leaves rather than per-commitment dynamic fields) cut it?
4. **Shared-object contention.** Everything touches `Pool`; localnet with one validator can't show
   consensus-level contention, but concurrent-submission throughput against the single shared object
   can be measured on this same harness.
5. **Re-measure the proving-time rows** against a Hermez ptau once a mirror is reachable (or confirm
   locally-generated pot15 gives identical times), and check live-network RGP/storage price.
