# 2026-11-06 — On-chain gas per entry point (queue item #1)

## Hypothesis

On-chain gas for Veil's entry points can be measured with real transactions on a local Sui network
(no testnet access needed), and the per-verification computation cost is large enough that batching
N transfers into one verify (queue item #3) would meaningfully cut per-transfer gas.
Number it moves: "Veil entry points with a measured gas figure" 0 → 10 of the pool's entry points.
The second half of the hypothesis is **refuted** (see Results).

## Threat / privacy model

No protocol change; no circuit or Move code touched. Relevant adversary: a **griefer / DoS actor** who
wants to make the pool expensive to use or to spam it. Gas numbers bound the griefing cost: an invalid
`shielded_transfer` costs the attacker ~1.0M MIST net (the computation floor) while the pool pays
nothing — the verification path is cheap enough that proof-spam is limited by the floor price, not by
verify cost. Does NOT establish: mainnet gas (local reference gas price is 1000 MIST/unit; mainnet's
varies), successful-verify gas (see below), `compliant_transfer` gas, shared-object contention.
Maps to STRIDE "Denial of service" in `docs/threat-model.md` (informs, does not change, any entry).

## Approach

Unblocking (the queue's advice): the `sui` CLI **is** obtainable — the prebuilt
`testnet-v1.83.1` Ubuntu tarball downloads via `github.com/.../releases/download` through the proxy.
`sui move test --build-env testnet` then passes **124/124** on the pinned framework. Public
fullnodes are denied by the sandbox (403 on `fullnode.testnet.sui.io`), so a local network
(`sui start --force-regenesis --with-faucet`) is used instead. JSON-RPC is removed in 1.83, so the
script drives the `sui` CLI (`--json`) rather than the SDK's JSON-RPC client.

Script: `scripts/bench/gas-localnet.ts`. Every figure is `effects.gasUsed` of an executed transaction.

**Verify rows use a garbage proof, not a real one.** `circom` is not installed and an attempt to
build it from source plus fetch the ptau was denied by the run's permission classifier, so no real
proofs exist tonight. Instead the script builds an on-curve, canonical but random VK/proof/public
inputs. `shielded_transfer`/`zk_withdraw` run `prepare_verifying_key` + `verify_groth16_proof` in full
and then abort with `E_INVALID_PROOF`(3)/`E_INVALID_WITHDRAW_PROOF` — the CLI output shows abort at
`execute_transfer` instruction 100, code 3, i.e. past the verify call. Sui charges computation for
aborted transactions, so the *computation* column is the true verify-path cost; the *storage* column
for those rows is NOT the cost of a successful transfer (nullifier/commitment writes never happen).

Rejected alternatives: `sui move test --statistics` "Gas Used" (reports a remaining-budget artefact,
e.g. 49999995000043, not usable); building the Sui workspace from source (hours).

## Results

Mean over runs, MIST (1 SUI = 10^9 MIST). Net = computation + storage − rebate.

| Entry point | runs | status | computation | storage | rebate | net |
|---|---|---|---|---|---|---|
| publish (whole package) | 1 | ok | 1,370,000 | 156,415,600 | 987,901 | 156,797,699 |
| create_pool | 2 | ok | 1,000,000 | 8,496,800 | 987,901 | 8,508,899 |
| token_faucet::faucet | 5 | ok | 1,000,000 | 4,043,200 | 2,705,329 | 2,337,871 |
| deposit_and_register (split + deposit PTB) | 5 | ok | 1,000,000 | 10,358,800 | 8,305,969 | 3,052,831 |
| freeze_pool / unfreeze_pool | 5 each | ok | 1,000,000 | 8,496,800 | 8,495,950 | 1,000,850 |
| propose_withdrawal | 5 | ok | 1,000,000 | 8,800,800 | 8,495,950 | 1,304,850 |
| cancel_withdrawal | 5 | ok | 1,000,000 | 8,496,800 | 8,799,920 | 696,880 |
| propose_withdraw_vk | 1 | ok | 1,000,000 | 11,726,800 | 8,495,950 | 4,230,850 |
| shielded_transfer, garbage proof (aborts after full verify) | 5 | abort 3 | 1,000,000 | 6,969,200 | 6,968,503 | 1,000,697 |
| zk_withdraw, garbage proof (aborts after full verify) | 5 | abort | 1,000,000 | 10,199,200 | 10,198,180 | 1,001,020 |

**Findings.**
1. Computation is **1,000,000 MIST for every pool call, including the two that run a full BN254
   Groth16 verify** — that is the minimum computation bucket (1000 units × 1000 MIST). The
   `~82K gas` `prepare_verifying_key` overhead noted in `verifier.move` sits inside the floor.
   Optimising it (storing a PreparedVerifyingKey) or batching verifies saves **0 MIST of
   computation at this price** — until computation exceeds the next bucket. Queue item #3's premise
   is refuted for gas; it may still matter for throughput or if the verify cost crosses a bucket.
2. Real cost is **storage**, driven by dynamic-field writes (deposit: 10.36M storage, 8.31M of which
   is rebated because the Pool object is rewritten). Net per deposit ≈ 3.05M MIST, flat across 5
   successive leaves — no growth with leaf count at n ≤ 5 (not an at-scale claim).
3. Successful `shielded_transfer`/`zk_withdraw`, `compliant_transfer`, and the remaining admin
   entry points are **still unmeasured**. Needs real proofs (circom + ptau).

Move tests: `cd contracts && sui move test --build-env testnet` → `Total tests: 124; passed: 124;
failed: 0` (raw in the run transcript). Circuit tests NOT run (no circom). Raw benchmark log:
[`2026-11-06-gas-localnet.raw.log`](2026-11-06-gas-localnet.raw.log).
Reproduce: start `sui start --force-regenesis --with-faucet`, `sui client switch --env local`,
`sui client faucet`, then `SUI_BIN=$(which sui) bun run scripts/bench/gas-localnet.ts --runs 5`
from `scripts/` (takes ~4 min incl. a 125 s timelock wait).

## Verdict

**KEEP (partial).** Gas axis closed for non-proof entry points and for the verify path's computation
cost; BASELINE.md updated. Item #3 re-ranked down. Remaining gap (successful-proof storage cost,
`compliant_transfer`) goes back to the queue, blocked on circom/ptau permission.

## Where this could be used

Any Sui protocol using `sui::groth16` per-transaction (private voting, ZK-gated airdrops): the
computation floor means on-chain verification is effectively free at current prices and design effort
should target storage (dynamic-field count) instead. Thesis: the scalability chapter's cost model —
"storage-bound, not verify-bound on Sui" — and a confidential payroll deployment with per-employee
commitments, where deposit storage dominates.

## Open questions

- Gas of a *successful* shielded_transfer (adds nullifier + commitment dynamic fields, removes one)?
- Does the computation cross the next bucket for `compliant_transfer` (two verifies)?
- Mainnet/testnet reference gas price vs the local 1000 MIST/unit?
- Storage cost at 10^5+ leaves (does dynamic-field fan-out change rebate/cost)?
