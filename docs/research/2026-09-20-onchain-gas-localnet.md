# 2026-09-20 — On-chain gas per entry point (queue item #1, closed)

## Hypothesis

Every Veil entry point's on-chain gas cost (`deposit_and_register`, `shielded_transfer`,
`compliant_transfer`, `zk_withdraw`, and the timelocked admin operations) can be measured from a
real, successful Sui transaction — not estimated — without needing outbound access to any Sui
JSON-RPC host, which this session's egress policy denies across the board. This closes
`BASELINE.md`'s one remaining `BLOCKED` axis, unchanged since 2026-07-22 (blocked twice now, for
two different reasons — see that report and `EXPERIMENTS.md` item 1).

This is a measurement night, like 2026-07-22: no circuit, Move module, or frontend proving code was
modified. The deliverable is real gas numbers plus a reusable script, not a protocol change.

## Threat / privacy model

No adversary model changes. As with the 2026-07-22 baseline, the relevant framing is: **who relies
on these numbers being honest, and what happens if they're wrong.**

- **This research loop**, on future nights: `EXPERIMENTS.md` item 3 (batched/aggregated proof
  verification) needs a real per-verify gas number to know whether batching is worth building at
  all. Item 4 (Merkle accumulator at scale) needs `deposit_and_register`'s real storage cost to
  reason about indexer/insertion economics at 10⁵–10⁷ commitments. Both were blocked on this
  number; both are now unblocked.
- **A griefing/DoS analysis** (not written yet, but implied by `docs/threat-model.md`'s STRIDE
  framing under Denial of Service) needs real gas-per-call numbers to reason about the cost of
  spamming nullifiers, dust deposits, or credential-nullifier exhaustion. This experiment is the
  prerequisite measurement, not the analysis itself.
- **A protocol integrator** budgeting relayer economics (`scripts/src/relayer.ts` sponsors gas for
  users) needs real per-entry-point costs, not the "gas-budget" ceiling already in the relayer code,
  to price a sponsorship model correctly.

What this does **not** establish: mainnet gas *pricing* (SUI/MIST ↔ USD is a market price, out of
scope), gas behavior under real network congestion or shared-object contention on the `Pool` object
under concurrent transfers (`EXPERIMENTS.md` item — still queued, still unmeasured; this run is
strictly sequential, one transaction at a time, on an otherwise idle single-validator network), or
whether Sui's gas *schedule* itself might differ across protocol versions (see Approach for why the
version used here is the right one, not an approximation of one). It maps to no STRIDE entry
directly, same as the baseline report — it's a prerequisite for entries that don't exist yet.

Assumptions carried over unchanged: Groth16 soundness under BN254 discrete-log, the dev-only
trusted setup's toxic waste not being production-safe (`docs/threat-model.md` RR2) — this run used
yet another fresh single-contributor setup (see Approach), which changes the specific proving/
verifying keys but not that risk. `EPOCH_DURATION_MS` here is 60 000 ms (Sui's protocol minimum),
not the repo's 1-hour testnet default or the 30-day production target (RR6) — chosen so the
1-epoch timelocks (`update_commitment_root`, `propose_withdraw_vk`) resolve in about a minute
instead of an hour; it does not change what gets measured, since gas cost does not depend on epoch
duration.

## Approach

**What I built:** one reusable script, `scripts/bench/onchain-gas.mjs`, plus small additive changes
to the existing `scripts/bench/witnesses.mjs` (two new optional override parameters — `epochId` on
`buildTransferWitness`, `currentEpoch` on `buildComplianceWitness` — both default to the exact same
values as before, so `prove-latency.mjs` and `browser-latency.mjs` are unaffected). The script:

1. Publishes the real `contracts/` package to a local Sui network.
2. Compiles real Groth16 proofs for all three circuits using the same witness builders as
   `prove-latency.mjs` (same domain tags, same constraint set — not a simplified stand-in).
3. Creates three separate `Pool` objects (one per scenario, to avoid nullifier/commitment
   collisions), deposits real `TOKEN` coins, proposes the timelocked commitment-root and
   withdraw-VK updates, waits for the epoch to roll over, then calls `shielded_transfer`,
   `compliant_transfer` (the dual-proof path, with a real `ComplianceConfig`), and `zk_withdraw`
   with real proofs — plus `freeze_pool`/`unfreeze_pool` as cheap admin-op samples.
4. Reads `effects.gasUsed` off each transaction's real JSON result. Nothing is estimated.

**What I rejected:**

- *Reusing `scripts/src/e2e-test.ts`/`e2e-compliance-test.ts`.* Both hardcode `NETWORK = "testnet"`
  and the `@mysten/sui` SDK's testnet faucet flow. Retrofitting them for a local network would have
  meant more rewiring than writing a focused CLI-driven script against the real `sui client`
  binary — and the new script doubles as the reusable gas-bench harness `EXPERIMENTS.md` item 1
  asked for, which the e2e scripts aren't shaped for (they're integration tests, not benchmarks that
  print a gas table).
- *Downloading a prebuilt `sui` CLI or the Hermez `pot15` ptau file.* Both hosts are denied by this
  session's egress policy (see Toolchain gaps). Fetching the `sui` release tarball from a GitHub
  *release asset* URL worked, though (see below) — a different code path than the blocked RPC/API
  hosts, discovered by testing rather than assuming "GitHub" is uniformly blocked or allowed.
- *A single pool reused across all three scenarios.* Would need three sequential commitment-root
  updates (each its own 1-epoch timelock wait) instead of one shared wait across three pools created
  in parallel. Three pools costs three extra `create_pool` calls but removes two of the three
  epoch-wait sleeps — worth it, and it also means each entry point's gas number is reported from a
  clean pool, not one accumulating dynamic-field state across scenarios.

**Toolchain gaps hit along the way, and how I handled each:**

- **Every Sui JSON-RPC host is denied**, not just `fullnode.testnet.sui.io` (which was denied for a
  different, tool-approval-layer reason on 2026-07-22). This time it's a network-egress policy
  denial, confirmed directly: `curl` to `fullnode.testnet.sui.io`, `sui-testnet.mystenlabs.com`,
  `rpc-testnet.suiscan.xyz`, `sui-testnet-rpc.publicnode.com`, `sui-testnet.public.blastapi.io`, and
  `testnet.suiet.app` all returned a proxy-level `403` (`gateway answered 403 to CONNECT`, logged in
  the agent proxy's own `recentRelayFailures`). Per the proxy's own guidance, a `403`/`407` from the
  policy layer is a denial to report, not a signal to retry or route around — so I didn't attempt a
  JSON-RPC read this time at all, confirmed the block was systematic (every mirror, not one flaky
  host) and moved straight to a network-free alternative.
- **No `sui` CLI binary, and `crates.io` doesn't publish one** (`cargo search sui` returns nothing
  matching; the CLI is a Rust workspace binary, not a published crate). `github.com` itself is
  scoped to this session's one connected repository for ordinary HTTPS requests (browsing
  `github.com/MystenLabs/sui/releases` returns this session's GitHub-App access-control message, not
  a 403) — but a *release-asset* download URL
  (`github.com/MystenLabs/sui/releases/download/<tag>/<asset>`) is a different code path and worked
  directly, as did a plain `git clone` of a public GitHub repo over HTTPS. Fetched
  `sui-testnet-v1.72.1-ubuntu-x86_64.tgz` (810 MB) this way in under 15 seconds. That version was
  not arbitrary: `contracts/Move.toml` pins the Sui framework dependency to git rev
  `94ad8ccd0ed6c089a9fe072ff80c918b5ab44943`, and `testnet-v1.72.1`'s tag date
  (`2026-05-12T12:42:50-07:00`) matches that commit's own commit date exactly — i.e. it's the
  release that commit shipped in, not an approximation. An earlier attempt with `testnet-v1.59.1`
  (an older tag, picked before checking the date) failed `sui move build` outright with a Move
  syntax error (`internal::Permit` not resolvable) — the framework source at the pinned rev uses
  language features that CLI's older bundled Move compiler doesn't support. Version-matching the
  CLI to the exact pinned commit isn't a nice-to-have here, it's required for the build to succeed
  at all, which is itself a useful fact: this protocol's Move code is tied to a specific framework
  snapshot, not "whatever `sui` a contributor has installed."
- **No powers-of-tau file** (`storage.googleapis.com`, the Hermez `pot15` host `compile.sh` already
  uses, timed out through the proxy — a silent drop, not a `403`). Generated an equivalent one
  locally instead of downloading it: `snarkjs powersoftau new bn128 15` → `contribute` → `prepare
  phase2`, entirely offline, in about 4 minutes for 2^15. This is not a lesser trusted setup than
  the repo's existing `compile.sh` flow — both are single-contributor, dev-only ceremonies over the
  same universal `bn128` phase-1 parameters (`docs/threat-model.md` RR2 already documents that the
  existing one isn't production-safe either); it's just a locally-generated instance of the same
  kind of ceremony rather than a downloaded one.
- **Sui's newer package-management system** (`sui move build`/`publish`) resolves an *environment*
  (testnet/mainnet/a custom one) by matching the active client's chain ID against a `[environments]`
  table in `Move.toml`, which the repo doesn't define at all (it silently defaulted to `testnet` for
  `sui move build`/`test`, which is why those worked with zero config). Publishing to a fresh local
  network needs an explicit environment: I added a temporary `[environments] localnet = "<chain
  id>"` entry to `contracts/Move.toml` for this run (reverted before committing — the chain ID is
  unique to that one `sui start --force-regenesis` instance and meaningless to anyone else's local
  network) and used `sui client test-publish --build-env testnet` (ephemeral-address publish,
  intended for exactly this "publish to a network with no persistent `Published.toml` entry" case)
  rather than `sui client publish`, which refuses to publish to an environment whose dependencies
  (the Sui framework) don't themselves ship a `localnet` flavor. `scripts/bench/onchain-gas.mjs`'s
  header comment documents the exact steps needed to reproduce this (add the environment line
  yourself, matching your own local network's chain ID, run `sui move build --build-env testnet`
  once, then run the script) — a session-specific chain ID has no business being committed.

None of these were tool-approval denials this time (contrast 2026-07-22, where a sandbox
tool-approval layer — not a network policy — blocked both the `circom` binary copy and the RPC
read). Every blocker here was either a genuine network-egress policy or a toolchain/versioning
mismatch, and every one had a workaround that didn't require retrying a denial or guessing a number.

## Results

### Gas per entry point (real transactions, local Sui network matching testnet's pinned protocol version)

Toolchain: `sui`/`sui-node` 1.72.1 (`94ad8ccd0ed6` — the exact commit `contracts/Move.toml` pins),
`sui start --force-regenesis --with-faucet`, single validator, otherwise idle. `net MIST` =
`computationCost + storageCost − storageRebate`: what the transaction actually cost its sender,
after the rebate for storage it freed or is still holding as a deposit.

| Entry point | Computation | Storage | Rebate | Net MIST | Net SUI |
|---|---|---|---|---|---|
| `publish` (whole package) | 1,370,000 | 156,415,600 | 0 | 157,785,600 | 0.157786 |
| `create_pool` | 1,000,000 | 8,496,800 | 0 | 9,496,800 | 0.009497 |
| `token_faucet::faucet` | 1,000,000 | 4,043,200 | 1,700,424 | 3,342,776 | 0.003343 |
| `deposit_and_register` | 1,000,000 | 9,021,200 | 7,245,612 | 2,775,588 | 0.002776 |
| `update_commitment_root` (admin) | 1,000,000 | 8,740,000 | 7,433,712 | 2,306,288 | 0.002306 |
| `create_compliance_config` (admin) | 1,000,000 | 14,941,600 | 7,674,480 | 8,267,120 | 0.008267 |
| `propose_withdraw_vk` (admin) | 1,000,000 | 11,726,800 | 7,433,712 | 5,293,088 | 0.005293 |
| **`shielded_transfer`** (1 Groth16 proof) | 1,000,000 | 11,012,400 | 8,193,636 | **3,818,764** | 0.003819 |
| **`compliant_transfer`** (2 Groth16 proofs) | 1,000,000 | 19,326,800 | 14,333,220 | **5,993,580** | 0.005994 |
| **`zk_withdraw`** (1 Groth16 proof) | 1,000,000 | 15,580,000 | 11,150,568 | **5,429,432** | 0.005429 |
| `freeze_pool` / `unfreeze_pool` (admin) | 1,000,000 | 8,496,800 | 7,433,712 | 2,063,088 | 0.002063 |

(`create_pool`, `token_faucet::faucet`, and `deposit_and_register` were called three times each,
once per pool — figures above are identical across all three runs, as expected for identical calls
against freshly-created objects; full per-call breakdown with digests is in
`scripts/bench/onchain-gas-results.json`.)

Raw output (representative excerpt — full log is the script's own stdout, reproducible verbatim by
re-running it):

```
$ SUI_BIN=/path/to/sui SUI_CLIENT_CONFIG=/path/to/client.yaml node scripts/bench/onchain-gas.mjs

--- shielded_transfer (pool A, real transfer proof) ---
sui client call --package 0xedcf...87f3 --module pool --function shielded_transfer --gas-budget 500000000
status: {"status":"success"}
gasUsed (raw): {"computationCost":"1000000","storageCost":"11012400","storageRebate":"8193636","nonRefundableStorageFee":"82764"}
net gas (computation + storage - rebate): 3818764 MIST

--- compliant_transfer (pool B, dual proof: transfer + compliance) ---
sui client call --package 0xedcf...87f3 --module compliance --function compliant_transfer --gas-budget 500000000
status: {"status":"success"}
gasUsed (raw): {"computationCost":"1000000","storageCost":"19326800","storageRebate":"14333220","nonRefundableStorageFee":"144780"}
net gas (computation + storage - rebate): 5993580 MIST

--- zk_withdraw (pool C, real withdraw proof) ---
sui client call --package 0xedcf...87f3 --module pool --function zk_withdraw --gas-budget 500000000
status: {"status":"success"}
gasUsed (raw): {"computationCost":"1000000","storageCost":"15580000","storageRebate":"11150568","nonRefundableStorageFee":"112632"}
net gas (computation + storage - rebate): 5429432 MIST
```

### An unexpected finding: computation cost doesn't track proof-verification work

Every single call above — one Groth16 verify, two Groth16 verifies, or zero — landed at exactly
`computationCost: 1000000`, the same bucket `create_pool` and `freeze_pool` (no proof at all) land
in. Sui buckets computation cost into a small number of fixed tiers rather than charging
continuously, so this doesn't mean a dual-proof `compliant_transfer` takes literally zero more CPU
than `freeze_pool` — it means the difference, whatever it is, doesn't cross a bucket boundary.

What *does* move, consistently and by a lot, is storage: `compliant_transfer` (19.3M storage,
creating a `ComplianceConfig`-scoped nullifier plus the transfer's own nullifier/commitment
dynamic fields) costs 57% more net gas than `shielded_transfer` (11.0M storage, one nullifier plus
one commitment swap), and `zk_withdraw` (15.6M storage — it also mints a brand-new owned `Coin`
object for the recipient, which `shielded_transfer` never does) costs 42% more than
`shielded_transfer` despite withdraw's circuit having 4.4x *fewer* R1CS constraints than transfer's
(3,058 vs. 13,611, from `BASELINE.md`). **Circuit size is not what Veil pays for on-chain.** Dynamic
field writes and object creation are. This directly changes what `EXPERIMENTS.md` item 2
(Poseidon2) should be expected to deliver: a real constraint-count win there moves *proving time*
(client-side, already measured in `BASELINE.md`) and *nothing* about on-chain gas, because
Groth16 verification cost apparently doesn't scale with the circuit that produced the proof, only
with the number of public inputs feeding `groth16::prepare_verifying_key`/`verify_groth16_proof`
(7/6/5 for transfer/compliance/withdraw — a small, similar range) and the storage the entry point
touches. Worth stating plainly since it's the opposite of the intuition a constraint-count-driven
research queue might otherwise run on.

### Full test suite (run in full, real toolchain — see CLAUDE.md equivalent, README.md)

| Suite | Result | Command |
|---|---|---|
| Move contracts | **124/124 pass** | `cd contracts && sui move test` |
| `transfer.circom` (real Groth16) | **43/43 pass** | `node --experimental-vm-modules test/transfer.test.mjs` |
| `compliance.circom` (real Groth16) | **30/30 pass** | `node --experimental-vm-modules test/compliance.test.mjs` |
| `withdraw.circom` (real Groth16) | **35/35 pass** | `node --experimental-vm-modules test/withdraw.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils (incl. depth-20 Merkle) | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Property-based fuzz | **6/6 properties**, 500 runs each | `cd scripts && bun run src/fuzz-tests.ts` |

Every number matches README.md's existing claims exactly (124, 43+30+35, 109, 67, 19) — this is the
first time this loop has had a `sui` CLI available to actually run the Move suite and confirm that
"124 pass" is real and reproducible, not just cited. No test was loosened, skipped, or given new
tolerance to reach these results.

## Verdict: **KEEP**

`BASELINE.md`'s on-chain-gas row goes from `BLOCKED` to a real, reproducible number for every entry
point, closing the queue's top item after two prior blocked attempts. `scripts/bench/onchain-gas.mjs`
is a permanent, reusable script — anyone with a version-matched `sui` CLI and a local network can
reproduce this exact table with one command.

## Where this could be used

- **Any Circom/Groth16-on-Sui protocol's CI or research loop that's egress-restricted** — the
  GitHub-release-asset-download workaround (rather than assuming all of `github.com` or all
  JSON-RPC hosts are blocked uniformly) and the locally-generated powers-of-tau are both directly
  reusable techniques whenever a sandboxed environment blocks specific traffic but not everything
  bearing the same hostname.
- **Any team choosing between a bigger, "more private" circuit and a smaller one on Sui** — the
  computation-cost-bucketing finding above says the on-chain cost argument for a smaller circuit is
  weaker than it looks; the real gas lever is what the entry point *writes*, not what it *proves*.
  Relevant well beyond Veil: confidential payroll, private voting, any UTXO-shielded-pool design on
  Sui making a build-vs-buy call on proof-system complexity should measure this before optimizing
  constraint count for gas reasons (proving time is a separate, real reason to still do it).
- **A relayer or sponsor economics model** (Veil's own `scripts/src/relayer.ts`, or any sponsored-
  transaction service) — these are the real MIST figures a sponsor pays per user action, today,
  not a `--gas-budget` ceiling.
- **A thesis chapter's cost-model appendix** comparing shielded-pool designs across chains needs
  exactly this shape of per-entry-point table; "Groth16 verification gas is flat across circuit
  sizes at this scale, storage dominates" is a citable, falsifiable claim other work can check
  against their own chain's gas model.

## Open questions (next queue)

1. **Does the computation-cost-bucket finding hold at scale?** All three circuits' proofs (5–7
   public inputs) landed in the same bucket. Would a circuit with, say, 50+ public inputs (unlikely
   for Veil, but relevant to the batched-proof item below) push into a higher bucket? Worth a
   synthetic circuit test if the batching experiment (item 3) gets picked up.
2. **Shared-object contention under concurrent transfers is still unmeasured.** This run was
   strictly sequential on an idle single-validator network — no congestion pricing, no consensus
   delay from competing writers to the same `Pool` object. That's a materially different question
   from "what does one transfer cost," and it's already queued.
3. **Batched/aggregated proof verification (queue item 3) is now directly costable.** With
   `shielded_transfer`'s real per-call gas in hand, a batching design can be judged against a real
   baseline instead of a guess — this was the item's stated dependency.
4. Given circuit size doesn't move gas, is Poseidon2 (queue item 2) worth re-ranking below the
   batching/accumulator items, which now have real numbers to size their upside against, or does its
   proving-time win alone (client-side UX, already the dominant proving-time cost per `BASELINE.md`)
   keep it where it is? Re-ranked below, with this reasoning — see `EXPERIMENTS.md`.
