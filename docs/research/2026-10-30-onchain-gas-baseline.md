# 2026-10-30 — On-chain gas per entry point (queue item #1)

## Hypothesis

Gas for every Veil pool entry point (`create_pool`, `deposit_and_register`, `shielded_transfer`,
`zk_withdraw`, admin ops) can be measured from real executed transactions — not estimated — and
will show whether Groth16 verification, rather than storage, is the cost Veil actually pays on
chain. This moves "on-chain gas per entry point" in `BASELINE.md` from **BLOCKED** to measured, and
decides whether queue item #3 (batched/aggregated proofs) can pay for itself.

## Threat / privacy model

No protocol change: no circuit, Move module, or frontend code was modified. The adversaries below
are the ones these numbers inform.

- **Griefing / spam attacker (STRIDE D2/D3).** A submitter who sends invalid proofs to burn pool
  and validator time. Measured: a rejected `shielded_transfer` costs the sender **1,101,992 MIST
  net** (0.0011 SUI); a valid one costs 3,113,712. The attacker pays ~35% of a legitimate
  transfer per failed attempt, and the cost is floored by the protocol's minimum computation
  bucket, not by anything Veil controls.
- **Chain observer / colluding relayer.** If a relayer batches several users' transfers into one
  Programmable Transaction Block (PTB) to save gas (see Results), every nullifier in that PTB is
  linked to the same relayer batch on chain. Timing/batch-membership leakage is new surface a
  batching relayer would introduce. Not tested tonight — recorded as an open question.

Does **not** defend against / establish: mainnet prices (localnet only, see Caveats), the
compliance verify entry points (not measured), contention on the shared `Pool` object under
concurrent load (single sender only), and anything about circuit soundness.

Assumptions: the Sui protocol config shipped in CLI 1.72.5 (the version matching the framework rev
pinned in `contracts/Move.toml`); a reference gas price of 1000 MIST/unit (read from the localnet
RPC: `suix_getReferenceGasPrice` → `"1000"`). Maps to STRIDE D2, D3 and I3 in
`docs/threat-model.md`; changes none of them.

## Approach

What was built: `scripts/bench/gas-localnet.ts` — publishes the real package to a local Sui
network, then executes every entry point as a real signed transaction and records
`effects.gasUsed` (computation, storage, rebate). Nothing is estimated.

**The circom blocker, and how it was sidestepped.** circom could not be built tonight (cloning and
building `iden3/circom` from source was denied by the session's permission layer; not retried or
worked around). On-chain Groth16 cost depends on the VK/input *dimensions* (pairings plus an
MSM over n public inputs), not on which circuit produced the proof. So the script builds a
**synthetic verifying key** of the real shapes (7 public inputs for transfer, 5 for withdraw) from
known random scalars and solves the Groth16 equation for `C`, yielding a genuinely valid proof
that passes the real `sui::groth16` verifier. Evidence it is real verification: the valid proofs
succeed on-chain and a one-bit-flipped proof aborts with code 3 (`E_INVALID_PROOF`,
`execute_transfer`). VK byte sizes follow `vkToSuiBytes` (232 + 32·nIC → 488 B transfer, 392 B
withdraw). This is **not** a measurement of Veil's real circuits' proofs — it measures the
on-chain side, which is circuit-independent by construction.

Alternatives rejected: JSON-RPC reads of historical testnet gas (the fullnode host is blocked by
the egress policy: `fullnode.testnet.sui.io` → 403); building `sui` from source (the prebuilt
release tarball from GitHub releases downloaded fine instead — the blocker recorded on 2026-07-22
is gone); `sui move test` gas stats (abstract units in the test harness, not billed gas).

Toolchain unblocked tonight: `sui 1.72.5` from `mainnet-v1.72.5` (a 1.60.0 CLI first tried could
not compile the pinned v1.72.x framework — `internal::Permit` unresolved — so the CLI must match
the pin).

## Results

Environment: localnet (`sui start --force-regenesis --with-faucet`), sui 1.72.5, RGP 1000,
single sender, 60 s epochs. Reproduce: from `scripts/`, `bun install`, start localnet, then
`bun run bench/gas-localnet.ts` (raw JSON-lines output:
[`data/2026-10-30-gas-localnet.log`](data/2026-10-30-gas-localnet.log)). All values in MIST
(1 SUI = 10^9 MIST). Net = computation + storage − rebate.

| Entry point | Computation | Storage | Rebate | **Net** |
|---|---:|---:|---:|---:|
| publish (whole package) | 1,380,000 | 156,415,600 | 4,890,600 | 152,905,000 |
| `create_pool` (488 B VK) | 1,000,000 | 8,496,800 | 978,120 | 8,518,680 |
| `propose_withdraw_vk` (392 B) | 1,000,000 | 11,726,800 | 8,411,832 | 4,314,968 |
| `deposit_and_register` | 1,000,000 | 12,251,200 | 11,421,432 | 1,829,768 |
| `shielded_transfer` (valid) | 1,000,000 | 14,242,400 | 12,128,688 | **3,113,712** |
| `zk_withdraw` (valid) | 1,000,000 | 15,580,000 | 12,128,688 | **4,451,312** |
| `shielded_transfer` (invalid proof, aborts) | 1,000,000 | 10,199,200 | 10,097,208 | 1,101,992 |
| `freeze_pool` / `unfreeze_pool` | 1,000,000 | 11,726,800 | 11,609,532 | 1,117,268 |
| `propose_vk_update` (488 B) | 1,000,000 | 15,443,200 | 11,609,532 | 4,833,668 |
| `cancel_vk_update` | 1,000,000 | 11,726,800 | 15,288,768 | −2,561,968 |
| `propose_withdrawal` | 1,000,000 | 12,030,800 | 11,609,532 | 1,421,268 |
| `cancel_withdrawal` | 1,000,000 | 11,726,800 | 11,910,492 | 816,308 |

(`zk_withdraw` measured twice, first call also applying the pending VK: identical. `deposit` was
identical on the 1st and 6th deposit into the pool.)

**Finding 1 — every single-call entry point has computation = 1,000,000 MIST exactly.** That is
Sui's minimum computation bucket (1000 units × RGP 1000). A single Groth16 verify is *below the
resolution* of a one-call measurement. To bound it, N valid `shielded_transfer`s were packed into
one PTB:

| N verifies / PTB | Computation | Marginal per verify vs previous row | Net per transfer | vs single (3,113,712) |
|---:|---:|---:|---:|---:|
| 1 | 1,000,000 | — | 3,113,712 | — |
| 5 | 1,810,000 | 202,500 | 2,394,118 | −23.1% |
| 10 | 3,400,000 | 318,000 | 2,361,919 | −24.1% |
| 20 | 6,830,000 | 343,000 | 2,358,320 | −24.3% |
| 40 | 152,200,000 | 4.3M (discontinuity) | 5,819,270 | **+86.9%** |

So a whole `shielded_transfer`'s computation is ≈ **0.34M MIST (≈340 gas units)** — about a third
of the minimum bucket it is billed at. Verification is not what users pay for.

**Finding 2 — storage dominates, and it is mostly the shared `Pool` object being rewritten.** A
no-op-ish admin call (`freeze_pool`) already shows 11.7M storage / 11.6M rebate: that is the Pool
object's own rewrite, ~99% rebated. Net per-transfer cost is the delta: new dynamic fields
(nullifier, new commitment) minus the removed old commitment's rebate.

**Finding 3 — PTB batching (no circuit change) saves ~24% net per transfer,** because the Pool
rewrite and the 1M computation floor are paid once per PTB. Saturates by N≈10.

**Finding 4 — a cost cliff between N=20 and N=40:** computation jumped 6.83M → 152.2M MIST
(22×) for 2× the work. Cause **not investigated** (consistent with Sui's instruction-count gas
tiering but unverified). Practical implication: do not batch more than ~20 transfers per PTB at
these sizes without locating the cliff.

Raw output (abridged; full file linked above):

```
{"op":"shielded_transfer (valid proof, 7 public inputs)","computation":1000000,"storage":14242400,"rebate":12128688,"net":3113712,...,"status":"success"}
{"op":"zk_withdraw (valid proof, 5 public inputs)","computation":1000000,"storage":15580000,"rebate":12128688,"net":4451312,...,"status":"success"}
{"op":"shielded_transfer (INVALID proof, aborts E_INVALID_PROOF)","computation":1000000,"storage":10199200,"rebate":10097208,"net":1101992,...,"status":"failure","error":"MoveAbort(... function_name: Some(\"execute_transfer\") }, 3) in command 0"}
{"op":"5 x shielded_transfer in one PTB","computation":1810000,...,"net":11970592,...}
{"op":"10 x shielded_transfer in one PTB","computation":3400000,...,"net":23619192,...}
{"op":"20 x shielded_transfer in one PTB","computation":6830000,...,"net":47166392,...}
{"op":"40 x shielded_transfer in one PTB","computation":152200000,...,"net":232770792,...}
```

Contract suite, run on the same CLI (also closes the `NOT RUN` row in `BASELINE.md`):

```
$ cd contracts && sui move test
Test result: OK. Total tests: 124; passed: 124; failed: 0
```

### Caveats (read before citing a number)

- **Localnet, RGP 1000.** Computation scales with the live reference gas price (varies by epoch on
  mainnet/testnet); storage price per byte is a protocol constant, so the storage columns carry
  over, computation columns scale linearly with RGP. No USD figure is given because no SUI price
  was measured.
- **Synthetic VK/proofs** (see Approach). On-chain cost is shape-dependent only; real circuit
  proofs should reproduce these numbers, but that was not re-verified tonight (circom blocked).
- **Not measured:** compliance verify entry points (need a `ComplianceConfig` + 6-input compliance
  proof flow), `emergency_withdraw`, and everything under concurrent load. Circuit test suites were
  not run (circom unavailable; no circuit changed). `CLAUDE.md`, referenced by the nightly prompt,
  does not exist in the repo; the Move suite above is the contract-side suite.
- Single run, no repeats: gas is deterministic for a given state, but state-dependent terms (Pool
  object size) mean numbers shift slightly as the pool grows.

## Verdict

**KEEP.** `BASELINE.md` updated in place (gas table, Move suite). Branch
`research/2026-10-30-onchain-gas-baseline`.

Consequence for the queue: **item #3 (aggregated proofs) is demoted.** Total computation per
transfer is ≈0.34M MIST of a 3.11M MIST net cost (~11%), and Groth16 verification is only part of
that. Aggregation could save at most a fraction of ~11%, versus 24% already available from PTB
batching with no cryptography. Storage (the Pool rewrite plus dynamic fields) is the cost to attack.

## Where this could be used

- **Any Sui protocol that stores per-user state as dynamic fields on one shared object** (privacy
  pools, shielded stablecoin rails, nullifier registries): this is a method for separating
  verification cost from storage cost, and the 1M-MIST floor means on-chain ZK verification there
  is effectively free below ~3 verifies/tx. Cite in the thesis chapter on on-chain cost models.
- **Confidential payroll on Sui with a t-of-n auditor board**: a payroll run is exactly the
  many-transfers-per-operator shape that PTB batching serves — ~24% net saving at N≥10, capped
  below the N≈20–40 cliff, at the price of linking the batch's nullifiers (see Open questions).
- The synthetic-VK technique is reusable for gas-benchmarking any Groth16-on-Sui verifier
  without compiling its circuit.

## Open questions (→ tomorrow's queue)

1. Where exactly is the PTB cost cliff between N=20 and N=40, and what causes it?
2. What does a batching relayer leak (nullifier co-membership in one tx) versus the ~24% saving —
   quantify the anonymity cost, not just the gas win.
3. Can the Pool rewrite be avoided? The 11.7M storage / 11.6M rebate on every call is the shared
   `Pool` struct; moving large fields (VKs, pending-update vectors) into dynamic fields or a
   separate object may cut per-call storage churn.
4. `verifier.move` carries a comment claiming ~82K gas saved by storing a `PreparedVerifyingKey`.
   Unverified: an A/B on this harness would settle it.
5. Real-circuit proofs on chain: re-run the harness with the actual compiled `transfer`/`withdraw`
   zkeys once circom is available, to confirm synthetic ≈ real.
6. Compliance verify gas (dual proof + ECDH ciphertext event).
