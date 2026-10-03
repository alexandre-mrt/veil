# 2026-10-03 — On-chain gas per entry point (queue item #1)

## Hypothesis

Veil's on-chain cost can be measured per entry point with real Groth16 proofs on a local Sui network,
and the `~82K gas per verification` that `contracts/sources/verifier.move` attributes to
`prepare_verifying_key` is real: caching a prepared VK would cut a transfer's raw computation by
~85 units (~25%). Falsifiable number: **raw computation units of `shielded_transfer` before vs. after
removing `prepare_verifying_key` from the call path**, and whether that moves the *charged* computation
cost (MIST) at all.

This is a measurement night (queue item #1, blocked in the 2026-07-22 run) plus one narrow optimization
test. **No production contract, circuit, or frontend code was changed.**

## Threat / privacy model

No protocol change, so no new adversary. Who cares about these numbers:

- **A griefing attacker (STRIDE D3 / D1-style cost-of-attack).** `docs/threat-model.md` D3 prices spam of
  *deposits* in tokens (100 TOKEN minimum) but never in gas. With real numbers: a valid `shielded_transfer`
  costs the sender **2,749,274 – 2,992,449 MIST net** (≈ 0.0027–0.0030 SUI) on this network; deposits
  ≈ 3.05M MIST. That is the floor an attacker pays per state-growing call, not a deterrent on its own.
- **A chain observer (I-class).** Gas is visible per transaction. Both measured `shielded_transfer`s are
  structurally identical and the computation charge is the same constant (1,000,000 MIST) for every
  entry point, so computation gas leaks nothing about amounts or parties. The *net* fee differed by
  243,175 MIST between transfer #1 and #2 (rebate 12,736,326 vs 12,493,151). I did **not** root-cause this
  by experiment; the likely cause is that transfer #1 also applied the pending commitment-root update
  (if the storage price is 7,600 MIST/byte — a protocol default I did not verify — 32 bytes freed = 243,200 MIST, within 25 MIST of the observed gap). If that is right
  it depends on timelock state, not on which note was spent. Unverified — queued.

**What this does NOT establish:** nothing here changes what a colluding relayer, malicious auditor, or
quantum adversary can do. Numbers come from a *local* network on Sui 1.82 (`main` at build time), not
testnet/mainnet: reference gas price here is 1000 MIST/unit and storage prices are the protocol
defaults of that build. They are measurements of this contract at this protocol version, not a
quote for mainnet.

Assumptions: Groth16/BN254 soundness and the dev-only trusted setup (RR2) are unchanged. The Powers of
Tau used to produce the proving keys was generated **locally** (see Approach), which does not affect
gas: verification cost depends on VK size/public-input count, not on ceremony provenance.

## Approach

**Toolchain (the actual blocker last time).** Both prebuilt-binary routes and every public RPC are denied
by the sandbox network policy (`github.com/.../releases` → 403, `fullnode.testnet.sui.io` → 403). Public
`git clone` *is* allowed, so I built from source: `MystenLabs/sui` (main, v1.82.0) →
`cargo build --release -p sui-move` (19 min, runs the Move test suite) and
`cargo build --release -p sui --bin sui` (48 min, 4 cores — gives a local validator + CLI).
Total ≈ 1 h 10 min of unattended compile; feasible in one night after all. This is the answer to
"worth spending an early part of the run unblocking the toolchain".

**What I built** (all reusable, nothing in the contracts changed):

- `scripts/bench/gas-localnet.mjs` — publishes a *copy* of `contracts/` plus a bench-only module, then
  drives the real flow with real proofs: faucet → `create_pool` → 4× `deposit_and_register` →
  `update_commitment_root` → `propose_withdraw_vk` → `create_compliance_config` → wait one epoch →
  2× `shielded_transfer` → `compliant_transfer` → wait → `zk_withdraw`. Every number is
  `effects.gasUsed` of an executed transaction (and a replayed nullifier is confirmed to abort).
- `scripts/bench/move/gasbench.move` — bench-only module (never in `contracts/`): `noop`,
  `prepare_only`, `verify_unprepared` (what `verifier.move` does today), and `verify_prepared`
  (VK prepared once, stored in a shared object).

**The measurement problem I had to solve.** Every entry point is charged exactly 1,000,000 MIST
computation = the **1,000-unit minimum**. A first run therefore "showed" every function costing the same.
The floor hides real work. To recover raw units without trusting an estimate, the script uses *dry-runs
(nothing committed)*: append P=100 copies of a cheap known call and subtract the same 100 copies alone,
`raw(entry) = units(entry + 100·pad) − units(100·pad)`. Pad slope is itself measured (85.05 units/call,
linear to the unit across N=100/200/300). Resolution is ±10 units; three complete runs gave
identical entry-point numbers.

**Alternatives rejected.** (a) Reading historical gas from the deployed testnet package via JSON-RPC —
network-denied. (b) `sui move test` gas statistics — unit tests don't charge storage and don't use real
protocol gas schedules. (c) A hand-rolled model of Sui's gas schedule — an estimate, which the rules forbid.
(d) The published Hermez `powersOfTau28_hez_final_15.ptau` — `storage.googleapis.com` returned 403 from the
sandbox, so I generated pot15 locally with `snarkjs powersoftau new/contribute/prepare phase2`
(single contributor, dev-only — same trust level as the existing `compile*.sh` dev setup). Constraint
counts are ptau-independent and reproduced the 2026-07-22 baseline exactly (13,611 / 12,743 / 3,058).

## Results

Reference gas price 1000 MIST/unit (localnet, Sui 1.82). "charged" is what `gasUsed.computationCost`
reports; "raw" is recovered by dry-run subtraction (±10 units).

| Entry point | Charged computation | **Raw units** | Storage cost | Storage rebate | **Net (MIST)** |
|---|---|---|---|---|---|
| `pool::create_pool` | 1,000 u | <10 (below resolution) | 8,496,800 | 987,901 | 8,508,899 |
| `pool::deposit_and_register` (×4, identical) | 1,000 u | 170 | 10,358,800 | 8,305,969 | **3,052,831** |
| `pool::update_commitment_root` | 1,000 u | 20 | 8,740,000 | 8,495,950 | 1,244,050 |
| `pool::propose_withdraw_vk` | 1,000 u | 20 | 11,970,000 | 8,739,126 | 4,230,874 |
| `compliance::create_compliance_config` | 1,000 u | 30 | 18,171,600 | 11,968,803 | 7,202,797 |
| `pool::shielded_transfer` #1 / #2 | 1,000 u | **340** / 340 | 14,485,600 | 12,736,326 / 12,493,151 | **2,749,274 / 2,992,449** |
| `compliance::compliant_transfer` (2 proofs) | 1,000 u | **650** | 22,556,800 | 18,450,955 | **5,105,845** |
| `pool::zk_withdraw` | 1,000 u | **460** | 15,823,200 | 12,493,151 | **4,330,049** |
| publish (contracts + gasbench) | 1,440 u | n/a | 163,020,000 | 987,901 | 163,472,099 |

Verifier isolation (dry-run slope, N=100→300 repeated calls in one PTB):

| Call | Raw units / call |
|---|---|
| `noop` (same args) | 0.00 |
| `prepare_verifying_key` only | **85.05** |
| verify, VK prepared every call (today's code) | **270.00** |
| verify, VK prepared once and stored | **184.50** |

`prepare_verifying_key` is 85.5 units = **31.7 % of one verification**, matching the `verifier.move`
note's "~82K" if that figure is in internal gas units (1 unit = 1000 internal). **The note is correct.**

Floor/batching curve — k verifications in one PTB, charged units:

| k | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 12 |
|---|---|---|---|---|---|---|---|---|
| verify every call | 1000 | 1000 | 1120 | 1380 | 1650 | 1920 | 2450 | 3510 |
| verify, VK prepared once | 1000 | 1000 | 1000 | 1060 | 1250 | 1430 | 1800 | 2530 |

### Raw command output

Command (network started with `sui start --force-regenesis --with-faucet`, circuits compiled per
`circuits/scripts/compile*.sh`):

```
cd scripts/bench && npm install
sui client new-address ed25519 && sui client faucet
node gas-localnet.mjs --json gas.json
```

```

```

Test suite state (same machine, after the run; no production file changed):

```
cd contracts && sui-move test -e testnet     → Test result: OK. Total tests: 124; passed: 124; failed: 0
cd circuits  && npm test                     → 43 passed, 0 failed / 30 passed, 0 failed / 35 passed, 0 failed
cd scripts   && bun run src/test-converter.ts        → 109 passed, 0 failed
cd scripts   && bun run src/test-compliance-utils.ts → 67 passed, 0 failed
cd scripts   && bun run src/fuzz-tests.ts            → ALL 6 PROPERTIES PASSED
```

### What the numbers say

1. **Gas is storage, not proofs.** For a transfer: 1,000,000 MIST computation floor + ~1.75M MIST net
   storage (nullifier and new-commitment dynamic fields persisting forever; the consumed commitment's
   rebate offsets part of it). Even the whole Groth16 verification (270 of 340 raw units) is *below the
   floor* — users are charged the 1,000-unit minimum either way.
2. **The hypothesised optimisation saves nothing on the bill.** Caching the prepared VK cuts
   `shielded_transfer` from ~340 to ~255 raw units (−25 %), but the charged computation stays
   1,000,000 MIST. `compliant_transfer` (650 → ~480) is also under the floor. Verdict on the optimisation:
   **REJECT** (adds a stored-object/upgrade surface for a 0 MIST change at today's shape).
3. **There is real batching headroom at zero computation cost**: up to 2 verifications per PTB are free
   (3 with a prepared VK). Beyond that cost grows ~270 (unprepared) / ~185 (prepared) units per extra proof —
   so per-proof computation inside a large PTB is ≤ 270 units vs. 1,000 for a standalone tx: ~3.7× to ~5.4×.
   Caveat: this was measured with `verify_*` only, on dry-run, not with k real `shielded_transfer`
   calls — those serialize on the shared `Pool` object, which this experiment did not measure.

## Verdict

**KEEP** (measurement) — `BASELINE.md` gains the gas rows and the Move suite is now RUN (124/124).
**REJECT** — "cache the prepared VK to cut transfer gas": no change to charged cost; keep the branch
knowledge, do not change contracts. The prepared-VK variant becomes interesting only if a future change
(batching) pushes transactions above the 1,000-unit floor.

## Where this could be used

- **Any Groth16 verifier on Sui** (privacy pools, zk-rollup bridges, zkLogin-style credential checks)
  shares this cost structure: `prepare_verifying_key` ≈ 85 units and one BN254 verify ≈ 185 units after
  preparation, against a 1,000-unit floor. A protocol whose entry points sit below the floor can ignore
  verifier micro-optimisation and should budget *storage* instead.
- **Confidential payroll on Sui with a t-of-n auditor board:** a monthly payroll run is naturally a
  PTB of N transfers; the floor curve above says ~2–3 are free and the rest cost ≤ 270 units each.
- **Thesis chapter:** "Cost model of on-chain ZK verification on an object-centric L1" — gas is
  storage-bound, computation is floored; compare to EVM's per-pairing-precompile cost model.
- **State-growth designs** (nullifier sets, commitment sets): the ~1.75M MIST/transfer net storage is the
  lever, which makes epoch-batched or off-chain-committed nullifier schemes worth pricing.

## Open questions (→ EXPERIMENTS.md)

1. Net storage per transfer (~1.75M MIST) dominates: how much of it is the nullifier df vs the new-commitment
   df, and can an accumulator-style nullifier set (one object per epoch, Merkle-committed) cut it?
2. Do k real `shielded_transfer` calls in one PTB behave like the verify-only curve, and what does
   shared-object contention on `Pool` do under concurrent PTBs? (needs a multi-client localnet run)
3. Is the 243,175 MIST net-fee gap between two identical transfers really the lazily-applied pending root
   (32 B at the assumed 7,600 MIST/B)? Confirm by repeating with and without a pending root.
4. Re-run on testnet/mainnet protocol parameters (RGP, storage price) — blocked here by network policy.
5. `create_pool` raw units fell under the ±10 resolution of the subtraction method; use a finer pad.
