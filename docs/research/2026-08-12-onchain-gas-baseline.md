# 2026-08-12 — On-chain gas per entry point (queue item #1)

## Hypothesis

Every Veil entry point's real Sui gas cost — `create_pool`, `deposit_and_register`,
`shielded_transfer`, `zk_withdraw`, `compliance::compliant_transfer` (dual Groth16 verify), and
the timelocked admin operations — can be measured from actual transaction effects on a real Sui
Move VM, not estimated from bytecode or guessed from constraint counts. This closes
`BASELINE.md`'s one remaining blank axis, unblocking queue items #3 (batched proof verification —
needs a real per-verify gas number to know what batching would save) and #4 (Merkle accumulator at
scale — needs a real per-commitment storage cost).

## Threat / privacy model

Like 2026-07-22's baseline run, this is a measurement night, not a protocol change: no circuit,
Move module, or frontend code was modified, so no adversary's capabilities change and nothing here
maps to a new STRIDE entry in `docs/threat-model.md`. The relevant framing is the same one that
report used: **who relies on these numbers being honest, and what breaks if they're wrong.**

- **Queue items #3 and #4**, directly. "Does batching N transfers into 1 verification save
  meaningful gas" and "what does inserting into a 10^6-leaf accumulator cost" are both diffs
  against the numbers in this report. A padded number here corrupts every future comparison.
- **Anyone estimating what a testnet or mainnet deployment costs a user.** `shielded_transfer` at
  ~2.9M MIST and `compliant_transfer` at ~5.0M MIST (see Results) are the numbers a wallet UI or a
  relayer's fee model would need.

What this does **not** establish: whether these costs are *good* relative to a comparable
protocol, whether Sui's gas schedule stays the same on testnet/mainnet (this ran against a fresh
local devnet-equivalent, not the deployed testnet package — see Approach), or anything about
proving time (already measured 2026-07-22) or circuit soundness (queued, item #5). Assumptions
carried over unchanged: Groth16/BN254 soundness, the dev-only trusted setup (RR2), and — new this
session — that a fresh local single-validator network's gas schedule and reference gas price match
what a real testnet/mainnet validator charges. Sui's gas *schedule* (per-operation unit costs, the
computation-cost bucketing described in Results) is a protocol-level constant compiled into the
node binary, not something a validator operator tunes, so this assumption should hold; the
reference gas price (which scales computation cost) is a network-wide value validators vote on and
can differ from this local network's default. That is called out explicitly below, not glossed
over.

## Approach

**The blocker, and how it was actually closed.** Blocked twice before (2026-07-22 ledger row) for
two different reasons: no `sui` CLI binary, and a denied ad-hoc JSON-RPC read against the deployed
testnet package. Tonight, both paths were re-tried from scratch:

- Direct JSON-RPC to `fullnode.testnet.sui.io` / `fullnode.mainnet.sui.io`: confirmed **blocked at
  the network-policy layer**, not an application error — `curl`'s `CONNECT` to either host returns
  HTTP 403, and the sandbox's own proxy status endpoint (`$HTTPS_PROXY/__agentproxy/status`) lists
  the rejection as `"kind": "connect_rejected", "detail": "gateway answered 403 to CONNECT (policy
  denial or upstream failure)"`. This is a deliberate network allowlist (only dev-tool registries —
  npm, crates.io, PyPI, the Go proxy — bypass the proxy), not a transient failure, so no amount of
  retrying or trying alternate RPC methods was going to get through it. Ruled out for good tonight;
  future runs shouldn't re-attempt it.
- `sui` CLI: `github.com`'s web/API endpoints return 400/403 through the proxy, but **`git clone`
  over HTTPS works** (confirmed by cloning the full `MystenLabs/sui` repo, 334 MB, cleanly). Built
  `crates/sui --bin sui` from source (`cargo build --release`, rev `944e5f24d`, matching
  `contracts/Move.toml`'s pinned framework rev `94ad8ccd0`) after installing `protobuf-compiler`
  via `apt` (also allowlisted). Total build time ~50 minutes across two runs — the first hit this
  session's own 40-minute safety timeout with every dependency crate already compiled and only the
  final `sui` crate left to link; resuming from the cargo cache finished in under 4 minutes. Also
  built `circom` v2.2.2 from source the same way (~2 minutes) to get real zkeys for all three
  circuits, since `BASELINE.md`'s artifacts aren't checked into the repo.

**Once the CLI existed, the real question was where to point it.** The already-deployed testnet
package (`README.md`'s package/pool/config IDs) is unreachable from this sandbox regardless of
having a CLI now — it's the same blocked network path. `sui start --force-regenesis --with-faucet`
runs a complete single-validator Sui network on `127.0.0.1:9000` with zero outbound calls: real
Move VM, real bytecode verifier, real gas metering, real `sui::groth16` native verification against
real proofs. What it is *not* is the specific testnet package with its specific (already-consumed)
object state — this run publishes a fresh copy of the same source and exercises it end to end.
The gas *schedule* is the thing being measured, and that's a property of the Sui binary, not of
which network it's running against (see the assumptions note above).

**What was built** (`scripts/bench/`):

- `generate-proofs.mjs` — real Groth16 proof generation for all three circuits, run in plain Node
  rather than the rest of the harness's Bun runtime. Reason: snarkjs's Node worker-thread path
  (the `web-worker` npm package) calls `self.dispatchEvent()` with a plain object; Bun 1.3.11's
  `EventTarget` is spec-strict and throws `TypeError: Argument 1 ('event') ... must be an instance
  of Event` — reproduced with and without `--smol`, a genuine Bun/snarkjs incompatibility, not a
  bug in this code. Isolating proving to a Node subprocess sidesteps it entirely. Witnesses mirror
  `circuits/test/*.test.mjs` and last night's `scripts/bench/witnesses.mjs`, with one addition:
  `pool.move`'s epoch check is real wall-clock time (`timestamp_ms / epoch_duration_ms`), not the
  small fixed counters (`epochId = 1n`, `currentEpoch = 500n`) the existing test fixtures use for
  circuit-only tests — so every epoch-bearing witness field here is parameterized by the actual
  on-chain epoch, pinned immediately before each round of submission.
- `gas-bench.ts` — deploys the contracts (`sui client test-publish --build-env local`; plain
  `sui client publish` requires `Move.toml` to declare a matching `[environments]` entry, which it
  doesn't for an ad-hoc localnet), then calls every entry point with real arguments and records
  `effects.gasUsed` verbatim from each transaction.

**Two timelocked admin dependencies had to be satisfied before any proof-bearing call would
succeed**, both real findings in their own right, not just plumbing:

1. `pool.move` initializes `commitment_root` to all-zero and only `pool::update_commitment_root`
   (itself 1-epoch timelocked) changes it. `shielded_transfer` checks the transfer proof's Merkle
   root against this field, so a freshly created pool cannot accept a transfer until an admin
   explicitly rotates the root — there is no "genesis root" that matches an empty tree with one
   real leaf. This is a legitimate operational property (the queue's Merkle-accumulator item #4 is
   exactly about how that root gets maintained at scale), but it means `update_commitment_root` is
   itself a measured entry point here, not overhead invented for the benchmark.
2. Two *different* transfer proofs are needed (`shielded_transfer` and the transfer proof nested
   inside `compliant_transfer`), each consuming a different genesis commitment. Each is modeled as
   the sole leaf of its own depth-20, all-zero-sibling tree (the same simplification
   `circuits/test/transfer.test.mjs` and last night's bench harness already use) — which means the
   two proofs need *different* roots, and the pool can only hold one root at a time. Hence two
   propose-root → wait-for-timelock → submit rounds in the harness, not one. **This is a benchmark
   artifact, not a real per-transfer cost**: in production the root is rotated in batches as new
   deposits land (queue item #4), not once per transfer, so `update_commitment_root`'s measured
   cost belongs on its own line, not amortized into `shielded_transfer`'s.

**What was rejected.** Considered mocking `sui::groth16` verification (e.g., a stub Move module
returning `true`) to avoid needing real proofs at all — rejected immediately: it would have
measured a different, cheaper, and dishonest program, defeating the point of a gas baseline.
Considered driving proof generation from inside `gas-bench.ts` under Bun with `--smol` disabled —
tried first, still crashed (same `web-worker` `dispatchEvent` error), so the Node-subprocess split
was the actual fix, not a workaround for a config flag.

## Results

Sui reference gas price on this local network: **1,000 MIST** (`suix_getReferenceGasPrice`).
Toolchain: `sui` 1.78.0 (`944e5f24d`, built from source), `circom` 2.2.2, Node v22.22.2, Bun
1.3.11, commit `f3f5d4f` of this branch.

| Entry point | Net MIST | Computation | Storage | Rebate |
|---|---|---|---|---|
| `pool::create_pool` | 8,518,680 | 1,000,000 | 8,496,800 | 978,120 |
| `pool::propose_withdraw_vk` | 4,314,968 | 1,000,000 | 11,726,800 | 8,411,832 |
| `pool::update_commitment_root` | 1,360,468 | 1,000,000 | 11,970,000 | 11,609,532 |
| `compliance::create_compliance_config` | 7,321,300 | 1,000,000 | 18,171,600 | 11,850,300 |
| `token_faucet::faucet` (mint) | 2,364,656 | 1,000,000 | 4,043,200 | 2,678,544 |
| `pool::deposit_and_register` | 3,172,232 | 1,000,000 | 14,075,200 | 11,902,968 |
| `pool::freeze_pool` | 1,122,132 | 1,000,000 | 12,213,200 | 12,091,068 |
| `pool::unfreeze_pool` | 1,122,132 | 1,000,000 | 12,213,200 | 12,091,068 |
| `pool::shielded_transfer` | 2,875,376 | 1,000,000 | 14,485,600 | 12,610,224 |
| `pool::zk_withdraw` | 4,453,744 | 1,000,000 | 15,823,200 | 12,369,456 |
| `compliance::compliant_transfer` (dual Groth16 verify) | 5,047,760 | 1,000,000 | 22,556,800 | 18,509,040 |

`deposit_and_register` is the mean of three identical-shape calls (3,172,232 MIST each, zero
variance — deterministic gas metering, not sampled noise). Full per-call breakdown including both
`update_commitment_root` rounds and every digest: `scripts/bench/gas-bench-results.json`.

**The unexpected finding: computation cost is identical — exactly 1,000,000 MIST, i.e. exactly
1,000 computation units at the 1,000 MIST reference price — across all eleven distinct entry
points measured, including `compliant_transfer`'s two independent `sui::groth16` verifications
against the same call that costs `freeze_pool`'s single boolean flip.** This is consistent with
Sui's computation cost being charged in coarse buckets rather than metered continuously per
executed instruction: everything measured here, from a single-field admin write to a dual Groth16
proof verification, falls inside the cheapest bucket. **Storage cost — driven by object size and
dynamic-field writes, not proof verification — is what actually varies and is what determines net
gas** for every call in this table. This has a direct, practical implication for queue item #3
(batched proof verification): if verification cost is already bucketed to the network's cheapest
tier, batching N verifications into one doesn't save *computation* MIST the way it would under a
linear-cost model — whatever it saves has to come from storage (fewer separate transactions' worth
of transaction-level overhead) or from amortizing the *fixed* per-transaction cost, not from
proving cost itself. That reframes item #3's hypothesis and is now an explicit open question below.

Raw command and output (deploy + one representative entry-point call; full transcript in the PR
description and `gas-bench-results.json`):

```
$ sui start --force-regenesis --with-faucet &
$ sui client switch --env local
$ sui client faucet
$ bun run bench/gas-bench.ts

=== Deploy package ===
[deploy] test-publish from /home/user/veil/contracts (ephemeral local addresses, gas budget 500000000)...
[deploy] Package published: 0x34a4997f92816e98fba3e4259dcc7a5a9e47040aa5d1be7917828300a3f5550e

=== create_pool (admin op) ===
  [info] pool::create_pool: net 8518680 MIST (computation 1000000, storage 8496800, rebate 978120)

=== compliance::compliant_transfer (dual Groth16 verify) ===
  [info] compliance::compliant_transfer: net 5047760 MIST (computation 1000000, storage 22556800, rebate 18509040)

Raw results written to /home/user/veil/scripts/bench/gas-bench-results.json
```

`suix_getReferenceGasPrice`:

```
$ curl -sS -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"suix_getReferenceGasPrice","params":[]}' \
    http://127.0.0.1:9000
{"jsonrpc":"2.0","id":1,"result":"1000"}
```

### Test suite (full, per CLAUDE.md/README — no test loosened, skipped, or given new tolerance)

| Suite | Result | Command |
|---|---|---|
| Move contracts | **124/124 pass** | `cd contracts && sui move test` |
| Circuits (real Groth16, all three) | **108/108 pass** (43 transfer + 35 withdraw + 30 compliance) | `node --experimental-vm-modules test/{transfer,withdraw,compliance}.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils (incl. depth-20 Merkle) | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Property-based fuzz | **6/6 properties, 2,500 cases** | `cd scripts && bun run src/fuzz-tests.ts` |

`sui move test` now needs the active `sui client` environment set to a named env
(`testnet`/`mainnet`/`devnet`) rather than the ad-hoc `local` one used for the gas benchmark itself
— `Move.toml`'s dependency declarations don't resolve for an environment with no matching
`[environments]` entry, and `sui move test` (unlike `test-publish`) has no `--build-env` escape
hatch. Switched envs for that one command; noted as friction for a future `Move.toml` cleanup, not
fixed tonight (out of scope for a measurement-only night).

## Verdict: **KEEP**

`docs/research/BASELINE.md`'s last blank axis now has real, reproducible numbers, closing the
2026-07-22 report's top open question. `scripts/bench/generate-proofs.mjs` and
`scripts/bench/gas-bench.ts` are reusable — rerunning this measurement after any future circuit or
Move change (Poseidon2, batched verification, a real accumulator) is `sui start --force-regenesis
&& bun run bench/gas-bench.ts`, no manual proof plumbing required.

## Where this could be used

- **Any Move-chain protocol budgeting a relayer or sponsor's per-transaction cost** — the
  computation/storage split found here (computation bucketed, storage dominant) is a Sui-wide gas
  model property, not specific to Veil's circuits, so the same profiling approach (and likely the
  same conclusion) applies to any `sui::groth16`-verifying contract, not just shielded-transfer
  protocols specifically.
- **A relayer economics model for Veil itself** (`scripts/src/relayer.ts` sponsors gas today) — a
  relayer covering `shielded_transfer` (~2.9M MIST) vs. `compliant_transfer` (~5.0M MIST) now has
  real numbers to price a sponsorship fee against, instead of a guess.
- **A thesis chapter or grant application budgeting compliance-gated DeFi on Sui** — "a
  KYC-gated confidential transfer costs ~1.75x a plain one, and the delta is almost entirely
  storage, not proof verification" is a specific, falsifiable claim this report backs with a real
  number, unlike a hand-waved "ZK proofs are expensive" framing.

## Open questions (next queue)

1. **Does batched/aggregated proof verification (queue item #3) actually save gas here, given
   computation is already bucketed to the cheapest tier for a single verification?** This report's
   biggest surprise reframes that hypothesis: the saving, if any, likely comes from amortizing
   fixed per-transaction overhead across N transfers, not from the verification step itself. Worth
   confirming directly: measure `compliant_transfer`'s cost bucket boundary — how many
   simultaneous verifications would it take to spill into the *next* computation bucket? — before
   assuming batching helps at all.
2. **What determines the storage-cost variance seen here** (`create_pool` at 8.5M vs.
   `freeze_pool` at 1.1M vs. `compliant_transfer` at 22.6M)? A follow-up could correlate each call's
   storage cost against the exact bytes written (VK size, dynamic field count, event size) to get a
   per-byte on-chain storage price, directly useful for queue item #4's accumulator cost model.
3. **Does the reference gas price (1,000 MIST here) match real testnet/mainnet validators'
   current price?** This run's local network uses `sui start`'s development default; if real
   validators vote a materially different price, every MIST number in this report scales linearly
   but the computation/storage *ratio* — the actual finding — does not.
4. Now that `sui` CLI and `circom` build cleanly from source in this sandbox (network policy
   permitting `git clone` over HTTPS and `apt`/`cargo`/`npm` installs), a future run could skip the
   toolchain-unblocking overhead entirely by checking whether this environment persists it, or
   documenting the from-source build as the standing procedure rather than something to
   re-discover blocked each time.
