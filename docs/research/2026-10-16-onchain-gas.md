# 2026-10-16 — On-chain gas per entry point (queue item #1)

## Hypothesis

Every Veil entry point — including the three that verify a Groth16 proof (`shielded_transfer`,
`zk_withdraw`, `compliant_transfer`) — can be driven with real proofs on a real Sui execution
environment and its `gasUsed` read from the validator's own transaction effects, closing the one
axis `BASELINE.md` marked BLOCKED. Falsifiable secondary claim, taken from the comment in
`contracts/sources/verifier.move` ("~82K gas overhead" for re-preparing the VK on every call):
**proof verification is a visible, separable component of a proof-bearing call's gas** — i.e.
`computationCost` of `shielded_transfer` is measurably larger than that of a call with no crypto.
This experiment moves "entry points with a measured gas number" from 0 to 16 transactions covering
every proof-bearing path.

## Threat / privacy model

No protocol change: no circuit, Move module, or frontend code was modified. Relevance to the
adversary model is the cost side of two existing STRIDE entries:

- **D3 (spam the pool with fake commitments)** — the mitigation is "100 TOKEN minimum per
  commitment". Real on-chain cost of one griefing deposit is now known (below): the attacker also
  pays net storage, not just the token deposit.
- **D2 / relayer economics** — a sponsoring relayer pays this gas for every user transfer; the
  per-transfer number is what bounds relayer subsidy and any "gas-exhaustion" attack on the relayer.

What this does **not** establish (residual surface): numbers come from a **localnet**, not testnet or
mainnet. Storage pricing and protocol config are those of the `sui` 1.72.5 binary (which matches the
framework revision `contracts/Move.toml` pins), but the **reference gas price (RGP) is the localnet
default of 1000 MIST/unit** and real networks set their own. All SUI-denominated values below are
therefore *localnet MIST*; the unit counts and the byte-driven storage costs are what transfer. It also says
nothing about shared-object contention under concurrent load (still unmeasured, queue item 11
territory), nor about the privacy leakage of gas amounts (a fixed per-entry-point gas signature is
visible on-chain; PRIV-006 mitigation is the sponsored gas coin, not constant gas).

Assumptions: the local validator's metering equals a production validator's for the same protocol
version (same binary family; unverified against mainnet in this run); the dev-only `snarkjs`
contribution used to produce the zkeys is irrelevant to gas (VK size, not ceremony quality,
affects cost).

## Approach

**What I built.** `scripts/bench/gas-localnet.mjs` — one command that, against a running localnet:

1. publishes the real `contracts/` package (`sui client test-publish`),
2. creates two pools (A: plain transfer + withdraw; B: compliant transfer) with the 60 s minimum
   epoch, mints tokens with `token_faucet::faucet`, deposits three standard-denomination
   commitments, sets the commitment roots (`update_commitment_root`), proposes the withdraw VK, and
   creates the compliance config,
3. waits one epoch boundary (timelocks + commitment maturity), generates **real Groth16 proofs** for
   `transfer`, `withdraw` and `compliance` with `snarkjs` against the freshly built zkeys, verifies
   each locally, then
4. executes `shielded_transfer`, `zk_withdraw`, `compliant_transfer` and reads
   `effects.gasUsed` (`computationCost`, `storageCost`, `storageRebate`, `nonRefundableStorageFee`)
   from each transaction.

`scripts/bench/witnesses.mjs` gained optional `opts` (epoch, threshold, userSecret, recipient,
transferNullifier) so the same witness builders can bind to a live pool; with no opts they return
exactly what `prove-latency.mjs` always used.

**Alternatives rejected.**
- *Testnet JSON-RPC history reads* (`suix_queryTransactionBlocks` on the deployed package): the sandbox
  egress proxy returns 403 on CONNECT to `fullnode.testnet.sui.io` (policy denial, logged by the proxy;
  not retried). Even if it worked, it would give only whatever mix of calls users happened to make.
- *Building `sui` from source*: unnecessary — prebuilt release binaries on `github.com/MystenLabs/sui/releases`
  were reachable. First candidate (1.60.0) could not compile the pinned framework (`internal::Permit`
  from a newer framework); 1.72.5 matches the pinned rev (`94ad8cc…`, tagged `mainnet-v1.72.x`).
- *`sui move test` instruction counts*: no real native Groth16 cost and not what a user pays.
- *`sui client dry-run`/`devInspect`*: not tried; real executions of committed state (with real
  rebates) were the ground truth wanted.

**Setup deviations (all gas-neutral).** `storage.googleapis.com/zkevm/...` (Hermez Powers of Tau) is
denied by the sandbox (403), so I generated a local `pot15` with `snarkjs powersoftau new/contribute/
prepare phase2` (single throwaway entropy — fine for measurement, unusable for a ceremony). VK byte
length depends only on the number of public inputs, so gas is unaffected. `circom` 2.2.2 was built from
source (`cargo install --git iden3/circom --tag v2.2.2`). Under `bun`, the script exits silently
during the epoch-wait timer, so the documented runner is `node` (>= 22.18 for the `.ts` import).

## Results

Environment: `sui 1.72.5-5445323ef25a` localnet (`sui start --force-regenesis --with-faucet`),
RGP 1000 MIST/unit, `node v22.22.0`, 4 vCPU Linux 6.18. Two full independent runs (fresh publish each)
were compared field-by-field: **all 16 rows identical in computationCost, storageCost, storageRebate
and net** — the numbers are deterministic.

| Entry point | computationCost (MIST) | storageCost | storageRebate | **net** (comp + stor − rebate) | net, SUI |
|---|---|---|---|---|---|
| publish (whole package) | 1,370,000 | 156,415,600 | 978,120 | **156,807,480** | 0.1568 |
| `create_pool` | 1,000,000 | 8,496,800 | 978,120 | **8,518,680** | 0.0085 |
| `token_faucet::faucet` (testnet-only) | 1,000,000 | 4,043,200 | 2,678,544 | **2,364,656** | 0.0024 |
| `deposit_and_register` | 1,000,000 | 10,358,800 | 8,223,732 | **3,135,068** | 0.0031 |
| `update_commitment_root` (propose) | 1,000,000 | 8,740,000 | 8,411,832 | **1,328,168** | 0.0013 |
| `propose_withdraw_vk` | 1,000,000 | 11,970,000 | 8,652,600 | **4,317,400** | 0.0043 |
| `create_compliance_config` | 1,000,000 | 15,184,800 | 8,652,600 | **7,532,200** | 0.0075 |
| **`shielded_transfer`** (1 proof, 7 pub. inputs) | 1,000,000 | 14,242,400 | 12,369,456 | **2,872,944** | 0.0029 |
| **`zk_withdraw`** (1 proof, 5 pub. inputs) | 1,000,000 | 15,580,000 | 12,128,688 | **4,451,312** | 0.0045 |
| **`compliant_transfer`** (2 proofs, 13 pub. inputs) | 1,000,000 | 19,570,000 | 15,552,108 | **5,017,892** | 0.0050 |
| `freeze_pool` / `unfreeze_pool` | 1,000,000 | 11,726,800 | 11,609,532 | **1,117,268** | 0.0011 |

(`deposit_and_register` and `update_commitment_root` ran on two or three pools/commitments each with
byte-identical results; `create_pool` ran for pools A and B with identical results.)

### The finding that kills the secondary hypothesis

**`computationCost` is exactly 1,000,000 MIST (= 1,000 units × 1,000 MIST) for all 15 non-publish
transactions** — including `freeze_pool`, `faucet` and `update_commitment_root`, which do no
cryptography, *and* `compliant_transfer`, which runs **two** Groth16 verifications plus two
`prepare_verifying_key` calls. Proof verification does not move metered computation off the floor;
its cost is below the resolution of Sui's computation bucketing. The "~82K gas overhead" comment in
`verifier.move` is real in internal gas units but invisible in what a user is charged.

Consequently on-chain cost of a transfer is **storage-dominated**: `shielded_transfer` nets 2.87M MIST,
of which 1.0M is the computation floor and the rest is net storage for the new commitment and the
(permanent) nullifier dynamic fields, minus the rebate for deleting the consumed commitment field.

### Test suites (all run on this checkout, no test touched)

- `sui move test` (contracts): `Test result: OK. Total tests: 124; passed: 124; failed: 0`
- `circuits` (run per file; see queue item 12 on the chained-`npm test` hang): transfer 43/0,
  compliance 30/0, withdraw 35/0 passed/failed
- `scripts` (`bun run test`): `Results: 109 passed, 0 failed`

### Raw output (`node scripts/bench/gas-localnet.mjs --json /tmp/gas1.json`, run 1)

```
=== Veil on-chain gas (localnet http://127.0.0.1:9000, reference gas price 1000 MIST/unit) ===
  publish (whole package)            success  comp=1370000 stor=156415600 rebate=978120 net=156807480
  package 0x474472aef7bd1338e4249e295b6cba5e583bce9fc2a2cdb910c403c91a2ed542
  create_pool (pool A)               success  comp=1000000 stor=8496800 rebate=978120 net=8518680
  create_pool (pool B)               success  comp=1000000 stor=8496800 rebate=978120 net=8518680
  token_faucet::faucet               success  comp=1000000 stor=4043200 rebate=2678544 net=2364656
  deposit_and_register (pool A / transfer commitment) success  comp=1000000 stor=10358800 rebate=8223732 net=3135068
  deposit_and_register (pool A / withdraw commitment) success  comp=1000000 stor=10358800 rebate=8223732 net=3135068
  deposit_and_register (pool B / transfer commitment) success  comp=1000000 stor=10358800 rebate=8223732 net=3135068
  update_commitment_root (pool A)    success  comp=1000000 stor=8740000 rebate=8411832 net=1328168
  update_commitment_root (pool B)    success  comp=1000000 stor=8740000 rebate=8411832 net=1328168
  propose_withdraw_vk (pool A)       success  comp=1000000 stor=11970000 rebate=8652600 net=4317400
  create_compliance_config           success  comp=1000000 stor=15184800 rebate=8652600 net=7532200

  waiting 11.5s for epoch boundary...

  proved transfer in 1514 ms
  proved transfer in 1004 ms
  proved compliance in 994 ms
  proved withdraw in 363 ms
  shielded_transfer                  success  comp=1000000 stor=14242400 rebate=12369456 net=2872944
  zk_withdraw                        success  comp=1000000 stor=15580000 rebate=12128688 net=4451312
  compliant_transfer (2 proofs)      success  comp=1000000 stor=19570000 rebate=15552108 net=5017892
  freeze_pool (pool A)               success  comp=1000000 stor=11726800 rebate=11609532 net=1117268
  unfreeze_pool (pool A)             success  comp=1000000 stor=11726800 rebate=11609532 net=1117268

reference gas price: 1000 MIST/unit; computation units = computationCost / 1000
wrote /tmp/gas1.json
```

Run 2 (`/tmp/gas2.json`) compared against run 1 with a 20-line Python diff of the JSON: every row,
every one of `computationCost`, `storageCost`, `storageRebate`, `net` equal (`True` in all 64 cells).

Reproduce:

```
sui start --force-regenesis --with-faucet &
sui client new-env --alias local --rpc http://127.0.0.1:9000 && sui client switch --env local && sui client faucet
(cd circuits && bash scripts/compile.sh && bash scripts/compile-withdraw.sh && bash scripts/compile-compliance.sh)
(cd scripts/bench && npm ci && node gas-localnet.mjs --json gas.json)
```

(If the Hermez ptau is unreachable, `snarkjs powersoftau new bn128 15 …` + `contribute` + `prepare phase2`
into `circuits/build/pot15_final.ptau` is a gas-neutral substitute; the `compile*.sh` scripts reuse it.)

## Verdict: **KEEP**

Measured, deterministic across two runs, and it changes the plan. `BASELINE.md`'s gas row is replaced
with these numbers. The secondary hypothesis (verification is a separable gas component) is
**REFUTED** at the resolution Sui charges. Caveat carried forward: localnet RGP, not mainnet; the
mainnet/testnet re-measure is one `--rpc` flag away once egress to a fullnode is permitted.

Effect on the queue: item 3 (**batched/aggregated proof verification**) loses its premise — per-call
verification adds ≈0 charged computation, so aggregating N proofs into 1 saves ≈0 gas; storage per
transfer (nullifier + commitment dynamic fields) is the cost that matters. It is re-ranked down and
re-scoped toward *storage* reduction.

## Where this could be used

- **Any Sui protocol that verifies `sui::groth16` proofs on-chain** (private payments, ZK-gated
  allowlists, confidential payroll with a t-of-n auditor board, ZK identity): the result generalizes —
  budget by *state written*, not by proofs verified. A design that verifies two proofs per call
  (Veil's compliant transfer) costs ~1.75× a single-proof transfer, almost entirely because it
  writes more bytes, not because it verifies more.
- **Relayer/sponsor economics**: a sponsor paying for ~0.003–0.005 SUI (localnet RGP) per transfer can
  size its float and rate limits from the table; the same script re-run on testnet/mainnet gives the
  real RGP-scaled number.
- **Thesis chapter on proof-system choice for Move chains**: the "verification cost" axis of a
  Groth16-vs-PLONK-vs-Halo2 comparison is moot on Sui as long as verification stays under the
  computation floor; the discriminating axes are proving time, VK/proof bytes written to storage and
  trusted setup.

## Open questions (next queue)

1. What is the *sub-bucket* cost of verification (the floor hides it)? A Move unit test with a real proof
   run under `--gas-limit` bisection, or `sui move test --trace`, could bound it — matters if Sui ever
   raises the floor or a batch verifier is considered.
2. Where do the storage bytes go in a transfer, and can they shrink? Candidates: nullifier + commitment
   as dynamic fields with 32-byte `vector<u8>` keys (a `Table<vector<u8>, …>`/bag, a hash-only key,
   or batching leaves into a single object); `deposit_and_register` pays 3.1M MIST per commitment —
   relevant to RR5/D3 and to the 10^5–10^7 commitment scale (item 4).
3. Re-run on testnet/mainnet RGP once a fullnode is reachable (single env var `SUI_LOCAL_RPC` + network
   name change), and add a **concurrent-transfer contention** run (N parallel `shielded_transfer`s on one
   shared `Pool`) — shared-object consensus latency, not gas, is the likely real throughput limit.
4. In a first debug run (not one of the two compared runs; the script was then still failing at
   `compliant_transfer`) `create_pool` for pool A showed `storageRebate` 4,890,600 instead of 978,120. Not
   understood — probably gas-coin history on a fresh localnet, but unconfirmed; not in the table.
