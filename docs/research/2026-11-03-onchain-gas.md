# 2026-11-03 — On-chain gas per entry point (queue item #1)

## Hypothesis

Every Veil Move entry point's real gas cost (computation, storage, rebate, net — in MIST) can be
measured from executed transactions on one machine with a working `sui` CLI, moving "entry points
with a measured on-chain gas number" from 0 to the full set. **Outcome: 10 of 13 relevant entry
points measured; the three proof-verifying ones (`shielded_transfer`, `zk_withdraw`,
`compliant_transfer`) remain UNMEASURED** — see Verdict.

This is a measurement night. No circuit, Move module, or frontend code changed.

## Threat / privacy model

No protocol security property changes. Who relies on these numbers: the future gas-cost DoS /
griefing analysis (STRIDE "Denial of Service" rows in `docs/threat-model.md`) and the batching
experiment (queue #3), both of which are blind without a per-verify gas number.

Not established here: the cost of Groth16 verification (the dominant, privacy-critical path) —
that is exactly the part not measured. Residual surface unchanged (RR1–RR9). Assumptions: the
numbers are from a **local** network (reference gas price 1000 MIST/unit), not testnet/mainnet;
computation *units* and storage *bytes* transfer, MIST prices do not (see Caveats).

## Approach

1. **Unblock the toolchain first** (the queue's own advice). A prebuilt `sui` 1.83.0 binary was
   fetched from the MystenLabs GitHub release (`testnet-v1.83.0`, `sui-testnet-v1.83.0-ubuntu-x86_64.tgz`,
   1.19 GB) — that works through the sandbox proxy and unblocks the CLI without a from-source
   build. Public fullnode JSON-RPC (`fullnode.testnet.sui.io`) is **not** reachable (proxy 403 on
   CONNECT), so the "recover historical testnet gas via `suix_queryTransactionBlocks`" route in
   the queue is closed in this environment.
2. Ran the Move suite: `sui move test` → **124/124 pass** (closes the "NOT RUN" row).
3. Ran a local network (`sui start --force-regenesis --with-faucet`), published the package
   (`sui client test-publish`), and executed each proof-free entry point as a real transaction
   through `sui client ptb --json`, recording `effects.gasUsed`. Script:
   `scripts/bench/gas-local.mjs` (reusable; prerequisites in its header).
4. **Rejected alternatives:** (a) estimating gas from Move unit-test instruction counts — not
   Sui gas, would be an estimate presented as a measurement; (b) a dummy Groth16 circuit to
   measure verifier gas — would not be Veil's verifier cost (different public-input count /
   VK), mislabel risk. (c) Building `circom` from source to get real proofs: attempted
   (`git clone iden3/circom` + `cargo build`) and **denied by the session's permission layer**;
   not retried or worked around.

## Results

Raw output of `node scripts/bench/gas-local.mjs --deposits 40` (per-tx JSON with digests in
[`data/2026-11-03-gas-local.json`](data/2026-11-03-gas-local.json)):

```
| Entry point | computation (MIST) | storage (MIST) | rebate (MIST) | net (MIST) |
|---|---|---|---|---|
| publish (whole package) | 1380000 | 156415600 | 5927407 | 151868193 |
| create_pool | 1000000 | 6551200 | 987901 | 6563299 |
| faucet (token_faucet::faucet) | 1000000 | 4043200 | 2705329 | 2337871 |
| deposit_and_register (leaf 0, empty pool) | 1000000 | 7075600 | 6360564 | 1715036 |
| deposit_and_register (leaf 39) | 1000000 | 7075600 | 6360564 | 1715036 |
| propose_withdrawal | 1000000 | 6855200 | 6550545 | 1304655 |
| cancel_withdrawal | 1000000 | 6551200 | 6854514 | 696686 |
| freeze_pool | 1000000 | 6551200 | 6550545 | 1000655 |
| unfreeze_pool | 1000000 | 6551200 | 6550545 | 1000655 |
| propose_vk_update (232-byte vk) | 1000000 | 8322000 | 6550545 | 2771455 |
| cancel_vk_update | 1000000 | 6551200 | 8321168 | -769968 |

deposit_and_register over 40 deposits: net min 1715036 / max 1715036, computation min 1000000 / max 1000000, storage min 7075600 / max 7075600
```

`sui move test` tail: `Test result: OK. Total tests: 124; passed: 124; failed: 0`.

Observations (each follows from the table above, not extrapolated):

- Every call sits at the **minimum computation bucket** (1,000,000 MIST = 1000 units × 1000 price).
  The proof-free entry points are storage-dominated, not compute-dominated.
- `deposit_and_register` net cost is identical for leaf 0 and leaf 39 (and across all 40) — no
  growth visible at this depth, as expected for a dynamic-field add. N=40 is small and computation
  is pinned to the minimum bucket, so this says "no cliff at low N", not "O(1) at 10^6" (queue #4).
- Net deposit cost is 1.7M MIST (≈0.0017 SUI at local pricing): one `CommitmentKey` dynamic field
  (~7.08M MIST storage, mostly rebated on the pool object rewrite).

## Caveats (read before citing)

- **Local network.** Reference gas price 1000 MIST/unit; testnet/mainnet differ, and storage
  price per byte is protocol-config dependent. Cite computation units / storage bytes across
  networks, MIST only for this configuration.
- Admin ops were called on a dummy 232-byte VK (length-checked only) — valid because no
  proof-verifying path was exercised.
- `publish` includes `token_faucet` (RR9) — not a mainnet figure.
- Single run, deterministic quantities; no variance reported because none observed (40 identical
  deposit costs).

## Verdict

**KEEP (partial) + PARK the remainder.** The ten proof-free rows and the 124-test pass are real
and merged into `BASELINE.md`. The proof-bearing entry points (`shielded_transfer`,
`zk_withdraw`, `compliant_transfer`) are **UNMEASURED**: they need compiled circuits, which need
`circom`, which the permission layer would not let this run build. Tomorrow's unblock: either
permission to build `iden3/circom` v2.2.2 (as the 2026-07-22 run did), or a prebuilt circom
binary; the gas harness already works and just needs three more `ptb` calls plus the proof-bytes
conversion from `scripts/src/proof-converter.ts`.

## Where this could be used

- **Confidential payroll on Sui with a t-of-n auditor board**: per-payee deposit cost (1.7M MIST
  net) × payroll size is the floor on funding a payroll batch; the proof-bearing numbers will set
  the ceiling.
- Any Sui shielded-pool design that registers commitments as dynamic fields (vs. a single
  on-chain Merkle root) can reuse `gas-local.mjs` unchanged to compare accumulator choices —
  thesis chapter on accumulator scalability (queue #4).

## Open questions (→ queue)

1. Gas for `shielded_transfer` / `zk_withdraw` / `compliant_transfer` (needs circom + circuits).
2. Does deposit cost stay flat at 10^4–10^6 commitments? (dynamic-field fan-out; queue #4.)
3. Storage dominates: could `CommitmentKey`'s stored `u64` epoch value be dropped or the
   commitments batched into one object to cut the ~7M MIST/deposit storage fee (rebated only on
   deletion)?
