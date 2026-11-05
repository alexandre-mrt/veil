# 2026-11-05 — On-chain gas baseline (queue item #1)

## Hypothesis
Real on-chain gas (MIST) for every Veil entry point can be measured on a local Sui network with a
prebuilt `sui` CLI, filling the last empty axis of `BASELINE.md`. Number moved: "gas per entry
point" from *unknown* to *measured*.

## Threat / privacy model
Measurement-only experiment; no protocol change, so no new adversary. Relevance: gas is the only
cost a chain observer can read for every call, so a call whose gas depends on secret-derived state
would be a (weak) side channel. Result below shows all non-proof calls are state-independent
(three deposits, byte-identical gas). **Not defended / not measured:** gas of proof-verifying
calls (see BLOCKED). Assumptions: local-network gas schedule equals testnet's for the same
protocol version (reference gas price 1000 MIST; not verified against testnet — the public fullnode
returned 403 from this sandbox's network policy). STRIDE: informational only (I/DoS, cost model).

## Approach
1. Unblock toolchain first (queue advice). Prebuilt `sui` v1.72.1 downloaded from the MystenLabs
   GitHub release; version chosen because `contracts/Move.toml` pins framework rev `94ad8cc` =
   tag `testnet-v1.72.1` (v1.60.0 was tried first and cannot compile that framework — raw error:
   `Could not resolve the name 'internal'`).
2. Ran `sui move test` (previously NOT RUN).
3. Local network (`sui start --force-regenesis --with-faucet`), `scripts/bench/gas-localnet.py`
   publishes the package and calls each non-proof entry point, reading `effects.gasUsed`.
Rejected: testnet JSON-RPC reads (403 from proxy); building Sui from source (hours).

## Results
Move tests: `Test result: OK. Total tests: 124; passed: 124; failed: 0` (`cd contracts && sui move test`).

Gas (MIST; net = computation + storage − rebate), command:
`sui start --force-regenesis --with-faucet &` then `python3 scripts/bench/gas-localnet.py`

```
| Call | Status | Computation | Storage | Rebate | Net (MIST) |
|---|---|---|---|---|---|
| publish (6 modules) | success | 1,370,000 | 156,415,600 | 978,120 | 156,807,480 |
| create_pool | success | 1,000,000 | 6,551,200 | 978,120 | 6,573,080 |
| token_faucet::faucet (1000 TOKEN mint) | success | 1,000,000 | 4,043,200 | 2,678,544 | 2,364,656 |
| deposit_and_register #1 (100 TOKEN) | success | 1,000,000 | 7,075,600 | 6,297,588 | 1,778,012 |
| deposit_and_register #2 (100 TOKEN) | success | 1,000,000 | 7,075,600 | 6,297,588 | 1,778,012 |
| deposit_and_register #3 (100 TOKEN) | success | 1,000,000 | 7,075,600 | 6,297,588 | 1,778,012 |
| propose_vk_update | success | 1,000,000 | 8,322,000 | 6,485,688 | 2,836,312 |
| cancel_vk_update | success | 1,000,000 | 6,551,200 | 8,238,780 | -687,580 |
| propose_withdrawal | success | 1,000,000 | 6,855,200 | 6,485,688 | 1,369,512 |
| cancel_withdrawal | success | 1,000,000 | 6,551,200 | 6,786,648 | 764,552 |
| update_commitment_root (propose) | success | 1,000,000 | 6,794,400 | 6,485,688 | 1,308,712 |
| freeze_pool | success | 1,000,000 | 6,794,400 | 6,726,456 | 1,067,944 |
| unfreeze_pool | success | 1,000,000 | 6,794,400 | 6,726,456 | 1,067,944 |
```

Reading: computation is pinned at 1,000,000 MIST for every call — the minimum computation bucket
at gas price 1000 — so these calls are *below the bucket floor*; it says nothing about the cost of
a Groth16 verify. Net cost is dominated by storage (e.g. a deposit stores one dynamic field plus
rewrites the shared Pool: 1,778,012 MIST ≈ 0.0018 SUI, identical across 3 deposits).

**UNMEASURED / BLOCKED:** `shielded_transfer`, `zk_withdraw`, `compliant_transfer` (Groth16
verification, nullifier+commitment storage). They need valid proofs, i.e. circom-built circuits.
Building circom v2.2.2 from source and `npm install` in `circuits/` were denied by the session's
permission layer; not retried or worked around. An aborted call with a garbage proof/zero VK would
not exercise pairing and was deliberately not reported as a number.

## Verdict
**KEEP (partial)** — Move suite verified (124/124), non-proof gas baselined, tooling documented.
Proof-path gas remains **BLOCKED** (missing: circom binary + circuits `node_modules`, i.e. permission
to build/install them) and stays at top of the queue.

## Where this could be used
Any Sui Move project verifying `sui::groth16` proofs needs the same local-network gas harness —
e.g. a confidential payroll pool on Sui with a t-of-n auditor board budgets per-payment fees from
exactly these storage-dominated numbers; thesis chapter: cost model of shielded pools on object-model chains.

## Open questions
- Gas of `shielded_transfer` / `zk_withdraw` / `compliant_transfer` (needs circom + circuits deps).
- Does testnet gas match localnet (needs a permitted fullnode read)?
- Storage dominates: could nullifier/commitment dynamic fields be cheaper (batching, bitmaps)?
