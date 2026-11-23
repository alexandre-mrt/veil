# On-chain gas per entry point, and what the prepared-VK cache would save (2026-11-23)

**Verdict: KEEP.** The gas axis of `BASELINE.md` is filled from real transactions. The
prepared-VK caching idea is **REJECTED** for single-proof transactions: it saves 0 MIST today. Along
the way the run found a **real fund-theft bug** (threat-model E7 is not mitigated, demonstrated
on-chain). It is reported below and queued as tomorrow's #1. It is not fixed in this PR.

## Hypothesis

Queue item #1 asked for Veil's on-chain gas per entry point. Nobody had measured it, and it was
BLOCKED twice. The falsifiable part is a claim already in the code. `contracts/sources/verifier.move`
says that storing a `PreparedVerifyingKey` instead of re-running `groth16::prepare_verifying_key` on
every call *"saves ~82K gas per verification"*. The hypothesis is that this reduces the
**charged computation cost of `shielded_transfer`** (baseline: unmeasured) by about 82,000 MIST.

Result: the preparation step does cost about 83 computation units (= 83,000 MIST at RGP 1000), so
the comment's number is right. But it is invisible in the fee. Under Sui gas model v15 every Veil
entry point, including `compliant_transfer` with two Groth16 verifications, uses fewer than the
1,000-unit minimum charge, so every call bills exactly 1,000,000 MIST of computation. Caching would
save **0 MIST** per transaction. Falsified.

## Threat / privacy model

This experiment is mostly a measurement, but two adversaries showed up.

**Gas griefing / economic adversary.** Someone who wants to know what it costs to spam or occupy
the pool. They see public gas costs. What we learn: one deposit costs about 3.05M MIST net
(0.00305 SUI) plus the 100 TOKEN denomination. That 100 TOKEN dominates the cost of D3
(dynamic-field spam), so tonight's numbers don't change D3's rating.

**Withdrawal thief (E7): relayer, validator, or anyone who sees a withdrawal proof before it
lands.** Today they can:

- take the 128-byte proof and 160-byte public inputs of a pending `zk_withdraw`;
- submit them with `recipient` set to their own address;
- receive the user's funds.

The circuit does prove `recipientHash = Poseidon(8, recipient)`. But `pool.move::zk_withdraw` never
checks that the `recipient` *argument* hashes to public-input bytes 96..128. The binding stops at
the proof boundary (the comment at `pool.move:595-599` says it is enforced; it is not). Who sees proofs early:

- **The relayer.** It receives the `TransactionKind` bytes in `/sponsor` (`scripts/src/relayer.ts`)
  and can build its own transaction from them.
- **Any validator or fullnode** that relays the transaction before execution.
- **Everyone, later, if the user's transaction aborts.** A failed `zk_withdraw` transaction, for
  example one that ran out of gas, is checkpointed with its inputs. The unspent proof is then
  public forever, and the first person to resubmit it with their own address takes the funds.

Demonstrated end to end, with a real transaction on a local network (raw output below).

**What this does NOT defend against.** Nothing here is a fix. Gas numbers come from a local network
on protocol version 142 (gas model v15). Testnet and mainnet run whatever protocol version they run.
Older versions (gas model < 15) use coarser computation buckets, so absolute computation costs can
differ there. Storage costs depend only on object bytes and `storage_gas_price` and should carry
over. Shared-object contention under concurrent load is not measured; every transaction here ran
one at a time.

**Assumptions.** Dev-only single-contributor Groth16 setup (as in `compile*.sh`). Phase-1 Powers
of Tau is now the PSE perpetual ceremony `ppot_0080_15.ptau` (sha256 `4a8eb5a7…2f3d`), because the
Hermez URL in `compile.sh` returns 403 from this sandbox. Phase 1 doesn't affect constraint counts,
proof size or gas. Recipient-as-field-element uses `address mod r`. The repo has no client convention
for this yet: the frontend `useWithdraw` hook still calls the admin-gated `emergency_withdraw`.

**STRIDE mapping** (`docs/threat-model.md`):

- **E7** "Front-run ZK withdrawal to steal funds": currently marked *Mitigated*. It is not. This PR
  corrects the status to *Open* and links this report.
- **The "Recipient binding" control row** in the controls table needs the same correction.
- **D3** (dynamic-field spam): cost now measured, as above.
- **I3** (relayer hides the sender): the relayer that provides I3 is also the most likely E7
  attacker.

## Approach

1. **Toolchain.** No `sui` binary was reachable: the GitHub release download and the Sui testnet
   fullnode both return 403 from the egress proxy. `git clone` of `MystenLabs/sui` works, so I built
   `sui` from source at tag `testnet-v1.84.1`. `cargo build --release --bin sui` took 32 min 03 s on
   4 cores (`sui 1.84.1-e83d69069e40`). I also rebuilt circom 2.2.2 from source. That unblocked the
   Move suite too (124/124 pass, below).
2. **`scripts/bench/run-gas-local.sh`** starts a fresh `sui start --with-faucet --force-regenesis`
   network, funds an address, publishes `contracts/` and the bench package with
   `sui client test-publish --build-env testnet`, then runs `gas-local.mjs`.
3. **`scripts/bench/gas-local.mjs`** calls every user and admin entry point, each in its own
   transaction. It uses **real Groth16 proofs** from the real circuits: a 4-leaf depth-20 commitment
   tree, a credential tree, epoch waits for maturity and timelocks. It records `effects.gasUsed`.
   Every row is a transaction a validator executed. Two adversarial probes are included: a
   transfer-proof replay, and a withdraw proof submitted with a different recipient.
   Sui 1.84 fullnodes serve **gRPC only** (JSON-RPC returns 404), so the harness uses
   `SuiGrpcClient`.
4. **`scripts/bench/move-pvk/`** is a bench-only Move package. It splits
   `prepare_verifying_key` + verify ("raw", what Veil does today) from `pvk_from_bytes` + verify
   ("cached") and from `prepare` alone. A single call is hidden under the 1,000-unit floor, so
   per-call cost comes from looping k = 20 and k = 40 times in one transaction and taking the slope.
   That cancels the fixed overhead.

**Rejected before building:**

- **Reading historical gas from the deployed testnet package.** The fullnode is blocked, and it
  wouldn't give a controlled per-entry-point run anyway.
- **`sui move test --statistics`.** The unit tests don't verify real proofs, so the native Groth16
  cost would be missing.
- **Changing `verifier.move` to cache the PVK and re-measuring.** That's a contract change. The
  bench package answers the question without touching production code, and the answer made the
  change unnecessary.

## Results

Local network, `sui 1.84.1-e83d69069e40`, protocol 142, reference gas price 1000 MIST
(`[info] reference gas price` in the log). All costs are in MIST.
`net = computation + storage − rebate`.

### Per entry point (one transaction each, real proofs)

| Entry point | Computation | Storage | Rebate | **Net** | Net (SUI) |
|---|---:|---:|---:|---:|---:|
| publish (whole package) | 1,380,000 | 156,415,600 | 4,939,506 | **152,856,094** | 0.1529 |
| `create_pool` | 1,000,000 | 8,496,800 | 987,901 | **8,508,899** | 0.0085 |
| `propose_withdraw_vk` | 1,000,000 | 11,726,800 | 8,495,950 | **4,230,850** | 0.0042 |
| `create_compliance_config` | 1,000,000 | 18,171,600 | 11,968,803 | **7,202,797** | 0.0072 |
| `update_commitment_root` | 1,000,000 | 11,970,000 | 11,725,627 | **1,244,373** | 0.0012 |
| `propose_compliance_toggle` | 1,000,000 | 11,977,600 | 11,968,803 | **1,008,797** | 0.0010 |
| `freeze_pool` / `unfreeze_pool` | 1,000,000 | 11,970,000 | 11,968,803 | **1,001,197** | 0.0010 |
| `token_faucet::faucet` | 1,000,000 | 4,043,200 | 2,705,329 | **2,337,871** | 0.0023 |
| **`deposit_and_register`** (split + deposit, 100 TOKEN) | 1,000,000 | 13,588,800 | 11,535,646 | **3,053,154** | 0.0031 |
| **`shielded_transfer`** (1 Groth16 verify) | 1,000,000 | 14,485,600 | 12,736,326 | **2,749,274** | 0.0027 |
| **`zk_withdraw`** (1 Groth16 verify) | 1,000,000 | 15,823,200 | 12,493,151 | **4,330,049** | 0.0043 |
| **`compliant_transfer`** (2 Groth16 verifies) | 1,000,000 | 22,556,800 | 18,458,554 | **5,098,246** | 0.0051 |
| `shielded_transfer` replay (same proof) | — | — | — | rejected in simulation: `MoveAbort 9` (`E_COMMITMENT_CHAIN_BROKEN`), never executed, no gas charged | |

Sui-encoded VK sizes: transfer 488 B, withdraw 424 B, compliance 456 B.

What the table says:

- **Computation is a constant 1,000,000 MIST on every Veil entry point.** That is the 1,000-unit
  minimum (`half_digits_rounding` in `sui-types/src/gas_model/gas_common.rs`: `n < 1000 → 1000`).
  Groth16 verification never pushes a Veil transaction off the floor, not even two verifications.
- **Storage is the real bill**, and it splits in two:
  - **The Pool object is rewritten on every call.** `freeze_pool` alone shows a gross 11.97M MIST
    storage charge, because both VKs and all pending fields live inline in `Pool`. 99% of that is
    rebated. The net cost is the 1% non-refundable fee, but the sender still has to *front* about
    12–22M MIST of gas budget per transaction. That matters for relayer liquidity.
  - **The net cost is new dynamic fields.** One per deposit commitment; on a transfer, a nullifier
    plus a new commitment minus the consumed one.

### Where verification computation actually goes (looped micro-benchmark)

Per-call units = (computation[k=40] − computation[k=20]) / 20 / RGP. `half_digits_rounding` rounds
values of 1,000–9,999 units up to the next 10 and values of 10,000–99,999 up to the next 100, so
each slope is good to about ±5.5 units.

| VK | `prepare_verifying_key` | verify, raw (prepare + verify, as Veil does) | verify, cached PVK | raw − cached |
|---|---:|---:|---:|---:|
| transfer (7 public inputs) | 83.0 | 267.5 | 184.0 | 83.5 |
| withdraw (5) | 83.0 | 247.0 | 165.0 | 82.0 |
| compliance (6) | 82.5 | 257.0 | 174.5 | 82.5 |

The verifier comment's "~82K" is right: it is 82–84 units, which is 82–84K MIST at RGP 1000. But
`shielded_transfer` uses fewer than 1,000 units in total, and so does `compliant_transfer` (about
525 units of verification). The saving falls inside the floor and the fee doesn't move.
`touch_n` stayed at the floor for both k, so the fixed per-transaction overhead is well under 1,000
units.

Caching would start to pay once a single transaction exceeds 1,000 units. That happens at about
4+ raw verifications per transaction, or about 6 cached ones. That's the batching question
(queue #3), not a single-transfer optimisation.

### E7 probe: recipient substitution

A withdraw proof generated for the signer (`recipient = 0x2200…0fa1`, `recipientHash` computed from
it) was submitted with `recipient = 0xabab…abab`. It **executed successfully**, and the withdrawn
`Coin<TOKEN>` was created owned by `0xabab…abab`. Gas was identical to the honest withdrawal. The
probe ran in both complete harness runs tonight (different package IDs and coin IDs, same
outcome).

### Test suites (this commit, this machine)

| Suite | Result |
|---|---|
| `cd contracts && sui move test` | **124 pass** (first time measured in this loop; sui 1.84.1 from source) |
| `cd circuits && npm test` | 43 + 30 + 35 pass, real Groth16. The chained run no longer hangs (queue #12, fixed by #17) |
| `cd scripts && bun run src/test-converter.ts` | 109 pass |
| `cd scripts && bun run src/test-compliance-utils.ts` | 67 pass |
| `cd scripts && bun run src/fuzz-tests.ts` | 6/6 properties pass |
| `cd frontend && bunx vitest run` | 19 pass |

Circuit recompile with the PSE ptau: transfer 13,611 constraints / 13,632 wires; compliance 12,743 /
12,762; withdraw 3,058 / 3,058. These are identical to `BASELINE.md`.

### Raw output

Full console: [`data/2026-11-23-gas-console.log`](data/2026-11-23-gas-console.log). Per-transaction
`gasUsed` JSON with digests: [`data/2026-11-23-gas-results.json`](data/2026-11-23-gas-results.json).
Command: `bash scripts/bench/run-gas-local.sh <out-dir>` (with `sui` on PATH; takes about 2 min,
most of it waiting for 60 s pool epochs).

```
[info] reference gas price: {"referenceGasPrice":"1000"}
[info] vk bytes: transfer=488 withdraw=424 compliance=456
[gas] create_pool                                  status=success comp=1000000 storage=8496800 rebate=987901 nonRefundable=99 net=8508899
[gas] propose_withdraw_vk                          status=success comp=1000000 storage=11726800 rebate=8495950 nonRefundable=850 net=4230850
[gas] token_faucet::faucet (mint 1000 TOKEN)       status=success comp=1000000 storage=4043200 rebate=2705329 nonRefundable=271 net=2337871
[gas] deposit_and_register (note A)                status=success comp=1000000 storage=13588800 rebate=11535646 nonRefundable=1154 net=3053154
[gas] update_commitment_root                       status=success comp=1000000 storage=11970000 rebate=11725627 nonRefundable=1173 net=1244373
[gas] create_compliance_config                     status=success comp=1000000 storage=18171600 rebate=11968803 nonRefundable=1197 net=7202797
[gas] shielded_transfer                            status=success comp=1000000 storage=14485600 rebate=12736326 nonRefundable=1274 net=2749274
[gas] shielded_transfer (replay, aborts)           status=rejected-in-simulation (MoveAbort 9 in pool::execute_transfer) — not executed, no gas charged
[gas] zk_withdraw                                  status=success comp=1000000 storage=15823200 rebate=12493151 nonRefundable=1249 net=4330049
[gas] zk_withdraw (recipient substituted)          status=success comp=1000000 storage=15823200 rebate=12493151 nonRefundable=1249 net=4330049
[E7] recipient substitution: status=success  — Coin<TOKEN> 0xf143105a2c5a4bc9fa9ec6c8a4a74e4b11d517add75a8d687a137bae5d034c2f now owned by 0xabababababababababababababababababababababababababababababababab (proof was generated for 0x2200a0c5c000bf9ad7ae1b494f20e5156fdc79115263cbd74699275074c00fa1)
[gas] compliant_transfer                           status=success comp=1000000 storage=22556800 rebate=18458554 nonRefundable=1846 net=5098246
[gas] pvkbench::prepare_only_n k=20 (transfer)     status=success comp=1690000 ...
[gas] pvkbench::verify_raw_n k=20 (transfer)       status=success comp=5350000 ...
[gas] pvkbench::verify_cached_n k=20 (transfer)    status=success comp=3710000 ...
[gas] pvkbench::touch_n k=40 (transfer)            status=success comp=1000000 ...
[gas] pvkbench::prepare_only_n k=40 (transfer)     status=success comp=3350000 ...
[gas] pvkbench::verify_raw_n k=40 (transfer)       status=success comp=10700000 ...
[gas] pvkbench::verify_cached_n k=40 (transfer)    status=success comp=7390000 ...
(withdraw and compliance rows: see the full log)
```

```
$ cd contracts && sui move test
...
Test result: OK. Total tests: 124; passed: 124; failed: 0
```

## Verdict

**KEEP**: the measurement, harness and bench package. `BASELINE.md`'s gas row goes from BLOCKED
to measured, and the Move-suite row from NOT RUN to 124 pass.

**REJECT**: "store a `PreparedVerifyingKey` to save ~82K per verification" as a single-transfer
optimisation. The units are real, the fee saving is 0 MIST. The `verifier.move` comment should be
reworded so nobody spends a night implementing it. That's left for the E7 fix PR, which touches
the same file area.

**Finding, not fixed here**: E7 recipient substitution. It's a contract change with its own
soundness and leakage story (address → field encoding, `sui::poseidon` compatibility with
circomlib, gas cost of an on-chain Poseidon), so it's queued as #1 rather than squeezed into a
measurement PR.

## Where this could be used

- **Any Groth16-on-Sui protocol whose proof names a payee** (mixers, private payroll payouts,
  zk-airdrop claims, bridge exits). The proof-binds-but-the-contract-doesn't pattern is generic. The
  `gas-local.mjs` probe (prove for A, submit for B) is a ten-line regression test that belongs in
  every such repo's CI.
- **Pricing a privacy pool on Sui.** On current protocol versions, ZK verification is effectively
  free at the margin (under the 1,000-unit floor). Cost engineering should target object layout:
  moving VKs out of the shared `Pool` into a separate immutable object would shrink the gross
  storage that has to be fronted on every call. So should the dynamic-field count per transfer.
  That inverts the usual EVM intuition, where the pairing check is the whole bill. Thesis chapter:
  "cost models of SNARK verification across L1 execution environments".
- **Relayer economics for sponsored transactions.** The 12–22M MIST gross gas each transaction must
  front, against about 2.7–5.1M MIST net, sets a relayer's working-capital requirement per
  in-flight transaction.

## Open questions → queue

1. **Fix E7**: in `zk_withdraw`, recompute `Poseidon(8, recipient mod r)` with
   `sui::poseidon::poseidon_bn254` and compare it to bytes 96..128. Needs: confirming circomlib
   compatibility of `poseidon_bn254`, a client convention for address→field (shared with the
   circuit tests), a Move test with a real proof, and **the measured gas of the on-chain Poseidon**.
   It should fit under the floor, but measure it.
2. **Relayer-side PTB batching (no contract change).** N `shielded_transfer` calls in one PTB share
   one computation floor and one Pool rewrite. Measure net MIST per transfer for N = 1..8, and what
   batching leaks (co-batched transfers are linkable by transaction digest).
3. **Move the VKs out of `Pool`** into an immutable object. Measure the drop in gross per-call
   storage (the about 12M fronted).
4. **The compliance proof is not bound to the transfer on-chain.** `compliant_transfer` never
   checks compliance public input 2 (`contextId`, bytes 64..96) against anything. A KYC'd user
   could generate compliance proofs for arbitrary contexts and lend them to non-KYC users.
   Investigate before the soundness audit (queue #5); possibly a new top-3 item.
5. **Re-measure on testnet's live protocol version** once a fullnode is reachable. Gas model < 15
   uses the older bucket table.
