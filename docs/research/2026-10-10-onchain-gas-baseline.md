# 2026-10-10 — On-chain gas per entry point (queue #1)

**Verdict: KEEP.** `BASELINE.md` now has real on-chain numbers, from real proofs, executed by a real
validator. Headline: **Groth16 verification is not what Veil pays for on-chain.** Every single-call
entry point — including `compliant_transfer`, which verifies two proofs — sits on Sui's
1,000-unit minimum computation charge; storage is the only thing that moves the bill.

Measurement environment is a local Sui network, **not testnet** (testnet was unreachable from the
sandbox — see Approach). Read "Caveats" before quoting a number.

## Hypothesis

With real Groth16 proofs on a real Sui validator, `pool::shielded_transfer` computation stays at
the 1,000-unit minimum charge (1,000,000 MIST at reference gas price 1,000) — i.e. on-chain
pairing verification is not the dominant gas cost, and cost variation between entry points comes
from storage. Falsified if `shielded_transfer`'s computation cost exceeds 1,000 units. A secondary
question, answered by a PTB probe: how much computation does each *extra* verified proof add once
the floor is crossed?

## Threat / privacy model

This is a measurement; it changes no protocol behaviour, so there is no new adversary. It does
quantify two existing STRIDE entries:

- **D3 / D1-style spam (docs/threat-model.md).** Adversary: any account that can submit
  transactions to the shared `Pool`. Measured: a rejected `shielded_transfer` costs the attacker
  **1,106,856 MIST** (≈ 0.0011 SUI) whether it aborts before the pairing or after it — Sui does
  not charge more for the Groth16 check, so there is **no gas asymmetry penalising invalid-proof
  spam**. Each such transaction still takes the Pool's shared-object slot. Not defended against:
  contention-based griefing of the Pool is bounded only by this ~0.0011 SUI price (and by whatever
  Sui does to shared-object congestion), not by anything Veil-specific. Residual surface, unchanged.
- **Cost-based deanonymisation.** The gas split between the three transfer-shaped calls is
  distinctive (`shielded_transfer` 2.88M, `zk_withdraw` 4.45M, `compliant_transfer` 5.29M net MIST),
  but the entry point itself is already public in the transaction's Move call; nothing new leaks.

Assumptions: the numbers are specific to Sui protocol version of `sui 1.81.1`, local-genesis
reference gas price 1,000 MIST/unit, and the storage price constants that binary ships with. They
are not claims about mainnet fees on any given day.

## Approach

**What I built.** `scripts/bench/gas-localnet.mjs` (+ `scripts/bench/README.md`). It publishes
`contracts/` to a local network, then drives every user-facing entry point with real proofs and
reads `effects.gasUsed` from each executed transaction:

- `witnesses.mjs` builders gained optional per-field overrides (defaults unchanged — re-ran
  `prove-latency.mjs`, same output shape) so proofs can be bound to the live on-chain epoch and to
  a real depth-20 Merkle tree (22 leaves, sparse zero-hashes above).
- The pool uses the 60 s minimum epoch so the 1-epoch timelock (commitment root, withdraw VK) and
  commitment-maturity rule are crossed in real wall-clock time, not mocked.
- Rejected-transaction rows: a threshold-byte flip (aborts before the pairing, code 5), a flipped
  `txAmountHash` (full pairing runs, then aborts, code 3), and a replay (code 9). Abort codes are in
  the raw JSON.
- A PTB probe: 2/4/6/8 `shielded_transfer` calls (distinct users, distinct leaves) in **one**
  transaction, to find the marginal computation per verified proof above the floor.
- The whole script was run **twice** (fresh keypair, fresh package publish each time).

**Getting a `sui` binary (what unblocked this).** `github.com/MystenLabs/sui` releases/API/codeload
are denied by the sandbox proxy (403, not retried). Docker Hub is reachable, so I pulled
`mysten/sui-tools:testnet-v1.81.1` by hand through the registry HTTP API (token → manifest → layer
blobs → untar; manifest sha256 `5336a71e…1de6` for the manifest JSON as fetched) and extracted
`/usr/local/bin/sui` → `sui 1.81.1-e04cf9aa915c`. The pinned framework dependency
(`MystenLabs/sui@94ad8ccd…`) is a git dep, also unreachable, but `raw.githubusercontent.com` is
allowed, so I fetched the `sui-framework` and `move-stdlib` source files at that exact rev
individually and pointed `Move.toml` at them with `local =` in a **scratch copy** of `contracts/`
(`Move.lock` removed; nothing else in the package touched; repo `contracts/` is unmodified). One
framework test-support file, `sources/test/test_scenario.move`, references a module
(`sui::display_registry`) whose path I could not locate in the raw tree; I deleted that single line
in the scratch copy. It is test-only (`test_scenario`), not part of Veil's published bytecode.

**Alternatives rejected.** (1) Unit-test gas (`sui move test --statistics`): reports Move-VM
internal units against a huge test budget, not what a validator charges, and the existing tests use
dummy proofs. (2) `sui client dry-run`/`devInspect`: no state transitions across the epoch
timelocks. (3) Building `sui` from source: far outside a night's budget. (4) Reading historical
testnet transactions over JSON-RPC: `fullnode.testnet.sui.io` is blocked at the proxy.

## Results

Environment: `sui 1.81.1-e04cf9aa915c`, RPC API 1.81.1, reference gas price **1,000 MIST/unit**,
1 validator, x86_64 Linux. Circuits recompiled here with circom 2.2.3 (the version CI pins):
13,611 / 3,058 / 12,743 constraints — identical to the 2026-07-22 baseline. `ptau`: generated
locally (dev-only; verification cost does not depend on it).

Net MIST = computationCost + storageCost − storageRebate. 1 SUI = 10⁹ MIST.

| Entry point | Computation units | Computation MIST | Net MIST | ≈ SUI |
|---|---:|---:|---:|---:|
| `pool::deposit_and_register` | 1,000 | 1,000,000 | 1,832,200 | 0.0018 |
| `pool::shielded_transfer` (1 proof) | 1,000 | 1,000,000 | 2,875,376 | 0.0029 |
| `pool::zk_withdraw` (1 proof) | 1,000 | 1,000,000 | 4,453,744 | 0.0045 |
| `compliance::compliant_transfer` (2 proofs) | 1,000 | 1,000,000 | 5,290,960 | 0.0053 |
| `pool::create_pool` | 1,000 | 1,000,000 | 8,518,680 | 0.0085 |
| `compliance::create_compliance_config` | 1,000 | 1,000,000 | 7,562,068 | 0.0076 |
| `pool::propose_withdraw_vk` | 1,000 | 1,000,000 | 4,314,968 | 0.0043 |
| `pool::propose_vk_update` | 1,000 | 1,000,000 | 4,836,100 | 0.0048 |
| `pool::cancel_vk_update` | 1,000 | 1,000,000 | −2,559,536 (net refund) | — |
| `pool::update_commitment_root` | 1,000 | 1,000,000 | 1,362,900 | 0.0014 |
| `pool::freeze_pool` / `unfreeze_pool` | 1,000 | 1,000,000 | 1,119,700 | 0.0011 |
| package publish (6 modules) | 1,370 | 1,370,000 | 156,807,480 | 0.1568 |
| *rejected* `shielded_transfer`, abort before pairing (code 5) | 1,000 | 1,000,000 | 1,106,856 | 0.0011 |
| *rejected* `shielded_transfer`, abort after pairing (code 3) | 1,000 | 1,000,000 | 1,106,856 | 0.0011 |
| *rejected* replay (code 9) | 1,000 | 1,000,000 | 1,104,424 | 0.0011 |

Derived (arithmetic on the rows above, not separately measured): the compliance dual-proof
overhead is `compliant_transfer − shielded_transfer` = **2,415,584 MIST (+84%)**; a 500-payment
payroll run of independent `shielded_transfer` calls would be 500 × 2,875,376 ≈ **1.44 SUI**.

### PTB probe — k verified transfers in one transaction

| k (proofs in one tx) | Computation units | Computation MIST | Net MIST |
|---:|---:|---:|---:|
| 1 (single-call row above) | 1,000 | 1,000,000 | 2,875,376 |
| 2 | 1,000 | 1,000,000 | 5,127,864 |
| 4 | 1,510 | 1,510,000 | 9,661,304 |
| 6 | 2,120 | 2,120,000 | 14,294,744 |
| 8 | 2,760 | 2,760,000 | 18,958,184 |

Above the floor the marginal cost is **≈ 305–320 computation units per extra verified
`shielded_transfer`** (4→6: 305/proof; 6→8: 320/proof; mean (2,760−1,510)/4 = 312.5). That
implies a fixed part of ≈ 260 units, so a *single* transfer's true compute is ≈ 570–600 units —
**an extrapolation: it sits under the 1,000-unit floor and cannot be observed directly.** Net MIST
grows ≈ 2.3M per extra transfer, almost all storage (new nullifier + commitment dynamic fields).

### Determinism

```
$ node -e '… compare gas-finalA.json gas-finalB.json on label, computationCost, storageCost, storageRebate, net …'
rows 66 66 diffs 0
```

Two independent end-to-end runs, 66 transactions each, zero differences.

### Raw output (run A; full logs and JSON in `docs/research/data/`)

```
rpc api 1.81.1, reference gas price 1000 MIST/unit, signer 0x6b78a8e8…
sui binary: sui 1.81.1-e04cf9aa915c

sui transfer (floor, 1 coin split+send)        ok    comp=  1000000 stor=  1976000 rebate=  9781200 net= -6805200
publish (all 6 modules)                        ok    comp=  1370000 stor=156415600 rebate=   978120 net=156807480
pool::create_pool                              ok    comp=  1000000 stor=  8496800 rebate=   978120 net=  8518680
pool::propose_withdraw_vk                      ok    comp=  1000000 stor= 11726800 rebate=  8411832 net=  4314968
compliance::create_compliance_config           ok    comp=  1000000 stor= 18171600 rebate= 11609532 net=  7562068
pool::deposit_and_register (leaf 0)            ok    comp=  1000000 stor= 12494400 rebate= 11662200 net=  1832200
pool::update_commitment_root (propose)         ok    comp=  1000000 stor= 12213200 rebate= 11850300 net=  1362900
shielded_transfer REJECTED early (threshold, pre-pairing) ABORT comp=  1000000 stor= 10685600 rebate= 10578744 net=  1106856
shielded_transfer REJECTED late (bad proof, post-pairing) ABORT comp=  1000000 stor= 10685600 rebate= 10578744 net=  1106856
pool::shielded_transfer                        ok    comp=  1000000 stor= 14485600 rebate= 12610224 net=  2875376
pool::shielded_transfer REPLAY (nullifier/commitment spent) ABORT comp=  1000000 stor= 10442400 rebate= 10337976 net=  1104424
compliance::compliant_transfer (2 proofs)      ok    comp=  1000000 stor= 22800000 rebate= 18509040 net=  5290960
pool::zk_withdraw                              ok    comp=  1000000 stor= 15823200 rebate= 12369456 net=  4453744
PTB: 2 x shielded_transfer in one tx           ok    comp=  1000000 stor= 18528800 rebate= 14400936 net=  5127864
PTB: 4 x shielded_transfer in one tx           ok    comp=  1510000 stor= 26615200 rebate= 18463896 net=  9661304
PTB: 6 x shielded_transfer in one tx           ok    comp=  2120000 stor= 34701600 rebate= 22526856 net= 14294744
PTB: 8 x shielded_transfer in one tx           ok    comp=  2760000 stor= 42788000 rebate= 26589816 net= 18958184
pool::propose_vk_update                        ok    comp=  1000000 stor= 15686400 rebate= 11850300 net=  4836100
pool::cancel_vk_update                         ok    comp=  1000000 stor= 11970000 rebate= 15529536 net= -2559536
pool::freeze_pool                              ok    comp=  1000000 stor= 11970000 rebate= 11850300 net=  1119700
pool::unfreeze_pool                            ok    comp=  1000000 stor= 11970000 rebate= 11850300 net=  1119700
```

(The first row, a plain SUI transfer, is a sanity row only: its negative net comes from rebating
the faucet-created gas coin's larger storage deposit, so ignore its `net`; its computation is the
floor.) Abort locations from the JSON: early → `execute_transfer` abort 5
(`E_THRESHOLD_MISMATCH`, instruction 42); late → abort 3 (`E_INVALID_PROOF`, instruction 100, after
the verifier call); replay → abort 9 (`E_COMMITMENT_CHAIN_BROKEN`, instruction 134).

### Test suites (all green, so a normal PR)

```
Move:     sui move test  → Test result: OK. Total tests: 124; passed: 124; failed: 0   (scratch copy, see Approach)
circuits: npm test       → transfer 43/0, compliance 30/0, withdraw 35/0  (exit 0, 47.7 s)
scripts:  test-converter 109 passed, 0 failed · test-compliance-utils 67 passed, 0 failed (5m34s)
          fuzz-tests: ALL 6 PROPERTIES PASSED
frontend: tsc --noEmit exit 0 · biome check exit 0 · vitest 19 passed (3 files)
```

`CLAUDE.md` does not exist in this repo; the suite above is the one `.github/workflows/ci.yml`
runs. (`test-compliance-utils` is slow — 5.5 min — and timed out once at 250 s while the circuit
tests were competing for CPU; rerun alone it passed.)

## Caveats (read before quoting a number)

1. **Local network, not testnet.** Reference gas price (1,000), storage price constants, and
   protocol version come from the `sui 1.81.1` genesis, not from live testnet/mainnet. Computation
   *units* and the *shape* (floor, storage-dominated) transfer; MIST amounts scale with the live
   reference gas price and with whatever storage price the live network uses. A testnet cross-check
   against the deployed package in `README.md` is queued (needs RPC access the sandbox denies).
2. **Framework sources fetched file-by-file** at the pinned rev via `raw.githubusercontent.com`;
   on-chain, the published package linked against the binary's own `0x1`/`0x2`. One test-only
   framework line removed in the scratch copy.
3. **Single validator, no network contention**; shared-object contention under concurrent senders
   is *not* measured (queued).
4. Dev-only `ptau` generated locally; circom 2.2.3 (not the 2.2.2 of the 2026-07-22 run) — constraint
   counts are identical, so proving artifacts have the same shape.
5. The ≈ 312.5 units/proof figure has a floor-clipped intercept; only k = 4, 6, 8 are above the
   floor. It is a three-point fit of a slightly super-linear series (305 → 320 units/proof), so
   treat it as ±5%.

## Verdict

**KEEP.** Hypothesis confirmed (`shielded_transfer` computation = 1,000 units = the minimum), plus
two results that change the queue:

- Per-call storage, not verification, is the on-chain bill — and a **2-proof `compliant_transfer`
  costs the same computation as a no-op**. Aggregating N transfers into one verification (queue #3)
  can save at most ≈ 312 units (≈ 0.0003 SUI at RGP 1,000) per proof of *computation*; it does not
  touch the per-transfer dynamic-field storage that dominates. Demoted.
- Every transaction touching the shared `Pool` re-charges the storage deposit of the objects it
  rewrites and rebates 99% (rejected tx: storage 10,685,600, rebate 10,578,744 = exactly 99%, net
  106,856). That figure covers the Pool *and* the gas coin; a plain 2-object SUI transfer is
  1,976,000, so the gas coin is ≈ 0.99M and the Pool ≈ 9.7M of it (derived). The standing cost of
  merely *touching* the Pool is therefore its 1% non-refundable fee, ≈ 97k MIST.
  Anything that grows `Pool` in place (e.g. an on-chain Merkle frontier, queue #4) raises that
  floor for **every** call, rejected ones included.

`BASELINE.md` is updated in place (gas table; Move tests 124/124 moved from NOT RUN).

## Where this could be used

- **Cost model for privacy pools on Sui.** On Ethereum a Groth16 check is paid per pairing
  (EIP-1108 precompile pricing — external reference, not measured here); on Sui, at this protocol
  version, a single-proof check disappears under the 1,000-unit floor and the bill is dominated by
  storage. Any ZK protocol on Sui (private voting, sealed-bid auctions, a Sui-native Tornado-style
  mixer) should budget *objects and dynamic fields written*, not pairings.
- **Confidential payroll on Sui with a t-of-n auditor board.** At ≈ 2.9M net MIST per payment, a
  500-employee run is ≈ 1.44 SUI at RGP 1,000 if each payment is its own call; the PTB probe shows
  batching saves only the first ≈ 1,000-unit floor and a few hundred computation units per proof,
  not the ≈ 2.3M-MIST-per-payment storage — so the cost lever for payroll is fewer/lighter
  dynamic fields per payment, not proof aggregation.
- **Thesis chapter:** evaluation / on-chain cost model — pair this with the 2026-07-22 proving-time
  table to show Veil's end-to-end cost is prover-bound (≈ 750 ms Node) and storage-bound on-chain,
  not verifier-bound. Also supports a "why not recursion/aggregation on Sui?" argument.
- **Harness reuse:** `gas-localnet.mjs` is the measurement rig for any later circuit/contract
  change (Poseidon2 swap, Merkle-root-on-chain, threshold auditing): same command, diff the table.

## Open questions → tomorrow's queue

1. How many concurrent `shielded_transfer`s per second can the single shared `Pool` sustain on a
   multi-validator local net, and what does invalid-proof spam do to honest-transfer latency?
   (Harness exists; needs `--committee-size 4` and a load generator.)
2. Does the ≈ 312-unit marginal proof cost hold on live testnet/mainnet protocol versions? A
   testnet cross-check of the deployed package (needs RPC access).
3. Which of the transfer's ≈ 1.88M net-storage MIST (`storage − rebate`) is the nullifier field vs
   the commitment-field churn — can the nullifier/commitment key layout be made cheaper (e.g.
   packing both into one dynamic field), and does it change the privacy analysis?
4. What does an on-chain Merkle frontier cost in the 1% non-refundable fee per Pool touch at
   depth 20 / 24 / 32?
5. Is the `Pool` object itself (≈ 9.7M storage MIST per rewrite, derived above) shrinkable by moving the three
   VK blobs into separate objects/dynamic fields, lowering the per-touch floor for every call?
