# 2026-09-18 — On-chain gas per entry point (queue item #1, closing the BASELINE.md gap)

## Hypothesis

Every Veil Move entry point's real on-chain gas cost — `deposit_and_register`, `shielded_transfer`,
`zk_withdraw`, `compliant_transfer` (with a real Groth16 proof verified in each proof-gated call,
not a stub), and the cheap admin operations — can be measured from an actual executed Sui
transaction's `effects.gasUsed`, closing the one axis `BASELINE.md` marked BLOCKED twice
(2026-07-22 baseline run, `EXPERIMENTS.md` item #1). This moves "on-chain gas" from BLOCKED to a
real, reproducible number for fourteen distinct entry points, and along the way resolves the Move
test suite's own BLOCKED status (124 tests, never run before tonight).

## Threat / privacy model

Like the 2026-07-22 baseline, this is a measurement night, not a protocol change — no circuit, Move
module, or frontend code was modified. The framing is again **who relies on these numbers being
honest**:

- **This research loop**, on every future night that touches gas: batched-proof verification
  (`EXPERIMENTS.md` #3, now #2) needs a real per-verify gas number to know what batching would save;
  it had nothing to diff against until tonight.
- **`docs/threat-model.md` D3** ("spam pool with fake commitments to exhaust dynamic fields") claims
  griefing is bounded by the 100/500/1000 TOKEN standard-deposit requirement. Tonight's numbers let
  that claim be checked against the *other* cost a griefer pays: gas. Real answer below (spoiler: gas
  is negligible next to the token requirement, so the mitigation's load-bearing part really is the
  token minimum, not gas — worth stating explicitly rather than assuming).
- **A protocol integrator** budgeting relayer economics (who pays gas for `shielded_transfer` on a
  user's behalf) needs real numbers, not the constraint-count-derived guesses that are all that
  existed before tonight.

What this does **not** establish: nothing about whether these gas costs are *competitive* with other
chains, nothing about mainnet gas price (this uses today's local-network reference gas price, 1000
MIST/unit — mainnet's reference price moves independently), and nothing about congestion costs under
concurrent load on the shared `Pool` object (queued separately as a scalability experiment). It maps
to no STRIDE entry directly — same as the 2026-07-22 report, it's infrastructure for entries that
don't exist yet — but it directly informs the cost side of **D3** (see Results) and **D2**
(relayer economics, `docs/threat-model.md`).

Assumptions unchanged from the existing threat model: Groth16 soundness under the BN254 discrete-log
assumption; the dev-only trusted setup (RR2) used to produce tonight's zkeys is explicitly
non-production, same caveat as 2026-07-22.

## Approach

**The blocker, and how it broke.** The 2026-07-22 report closed with two independent reasons the
`sui` CLI was unavailable: no prebuilt binary reachable (`github.com/.../releases/...` returned
`403`), and the `crates.io` API rejected requests. Tonight, both **raw HTTPS GET requests** to
`api.github.com`, `crates.io`, and `fullnode.testnet.sui.io` still return `403` from this
environment's egress proxy — but `git clone`/`git ls-remote` over `https://github.com/...` works
(git's smart-HTTP protocol, apparently on a different allow-list than plain REST calls), and,
critically, a direct `curl` to a **GitHub Releases download URL**
(`github.com/MystenLabs/sui/releases/download/<tag>/sui-<tag>-ubuntu-x86_64.tgz`) returned `200`
and transferred the full ~800MB–1GB asset. That one working path is enough: no `crates.io` API, no
`api.github.com`, no fullnode JSON-RPC needed at all.

The first download (`testnet-v1.59.1`) installed and ran, but `sui move build` failed —
`contracts/Move.toml` pins the Sui framework at a specific git rev
(`94ad8ccd0ed6c089a9fe072ff80c918b5ab44943`), and that rev's framework source uses newer Move syntax
(a `public(internal)`-style visibility modifier) than the `v1.59.1` compiler understood. Resolving
which CLI *tag* corresponds to that framework rev took one more step outside the blocked hosts: `git
tag --contains <rev>` (again over the working git-protocol path) named `testnet-v1.72.1` /
`mainnet-v1.72.x`. Re-downloading that exact tag's release asset fixed it — `sui --version` now
reports `1.72.1-94ad8ccd0ed6`, the same hash as `Move.toml`'s pin. **Lesson for the next run that
needs the CLI: match the release tag to `Move.toml`'s pinned `rev`, don't grab "latest testnet."**

`sui client publish` then refused to run: the package's `Move.lock` only pins dependency addresses
for the `testnet` environment (the new Move package-management system's `[environments]` table), and
a local network's chain ID has no entry. Adding a `[environments] local = "<chain-id>"` line to
`Move.toml` did *not* fix it — tracing `sui`'s own source
(`external-crates/move/crates/move-package-alt/src/package/root_package.rs`, `Manifest::read_from_file`
inside `RootPackage::environments()`) shows manifest-read failures there are swallowed silently,
falling back to built-in defaults only. Rather than debug that further, `sui client publish`'s own
error message pointed at the right tool: **`sui client test-publish --build-env testnet
--pubfile-path <ephemeral file>`** — it compiles against `testnet`'s pinned dependency addresses
(fixed system-package IDs like `0x1`/`0x2` that are identical on every Sui network) but *executes*
against whatever network the CLI is actually pointed at. That is exactly "build once, publish
anywhere the framework ABI matches," which a local network satisfies.

**Why local, not testnet.** `fullnode.testnet.sui.io:443` is still blocked outright (`403` on
`CONNECT`, confirmed again tonight, same as 2026-07-22). A **local** Sui network
(`sui start --force-regenesis --with-faucet`) needs no outbound network access at all once the CLI
binary and circuit toolchain exist, and — this is the load-bearing claim for trusting these
numbers — it runs the *exact same* `sui` binary and therefore the *exact same* protocol-defined gas
schedule (computation-unit buckets, storage cost per byte, storage rebate curve) that testnet or
mainnet would apply. Gas cost in Sui is a function of the protocol version, not the network identity.

**What I built:**

- `scripts/bench/proof-format.mjs` — the Sui byte-encoding functions (`proofToSuiBytes`,
  `publicInputsToSuiBytes`, `vkToSuiBytes`, arkworks-compressed BN254 points), ported from
  `scripts/src/proof-converter.ts` so `scripts/bench/` stays a plain-Node package (no bun/TS
  toolchain dependency) — the same tradeoff `witnesses.mjs` already makes for circuit witnesses.
- `scripts/bench/onchain-gas.mjs` — deploys the package to a local network, drives **every**
  proof-gated and admin entry point with a real transaction, and records `effects.gasUsed` for each.
  Reusable: re-run it against any local network started per the header-comment instructions, and it
  regenerates its own Groth16 proofs from the compiled circuit artifacts each time.

**The bug I caught before it produced wrong numbers.** `scripts/bench/witnesses.mjs` (built
2026-07-22 for isolated proving-time benchmarks) hardcodes `epochId = 1n` / `currentEpoch = 500n` —
fine for timing `snarkjs.groth16.fullProve` in isolation, but `pool.move`'s `pool_epoch` is
`clock.timestamp_ms() / epoch_duration_ms`, an **absolute** value (tens of millions, not `1`). A
proof built with a placeholder epoch would fail the on-chain
`proof_epoch == on_chain_epoch || on_chain_epoch - 1` check every time. `onchain-gas.mjs` therefore
does not reuse `witnesses.mjs` directly for the transfer/compliance proofs — it queries the live
`Clock` object, computes the real epoch, and rebuilds the epoch-dependent fields (the transfer
nullifier; the compliance `contextId`/nullifier, which must also be cryptographically bound to the
*same* transfer's real nullifier for `compliant_transfer`'s context-binding check to pass) right
before generating those two proofs. `withdraw` has no epoch dependency at all (`zk_withdraw` never
checks `pool_epoch`) so its proof is safe to build any time.

**What I rejected.** I considered hand-crafting proofs entirely with a mock/no-op verifier (some
protocols expose a "skip verification" test mode) to avoid the circuit toolchain rebuild —
rejected, because "gas cost of calling `shielded_transfer` with a proof the verifier never actually
checks" is not the same number as the real thing, and the whole point of tonight is no estimates. I
also considered patching `Move.toml` to add a persistent `local` environment entry (see the
package-alt bug above) — rejected in favor of `test-publish`, which needed no repo changes and is
the tool the CLI's own error message names for exactly this case.

## Results

### Gas per entry point (local network, `sui` 1.72.1-94ad8ccd0ed6, reference gas price 1000 MIST/unit)

"Net cost" = `computationCost + storageCost − storageRebate` (what the caller's balance actually
drops by; matches how a wallet would display it). Full raw JSON:
`scripts/bench/onchain-gas-results.json` (reproduced below in full).

| Entry point | Proof(s) verified | Computation (MIST) | Storage (MIST) | Rebate (MIST) | **Net (MIST)** | **Net (SUI)** |
|---|---|---:|---:|---:|---:|---:|
| `publish` (package) | — | 1,370,000 | 156,415,600 | 978,120 | **156,807,480** | 0.15681 |
| `create_pool` | — | 1,000,000 | 8,496,800 | 978,120 | **8,518,680** | 0.00852 |
| `token_faucet::faucet` | — | 1,000,000 | 4,043,200 | 2,678,544 | **2,364,656** | 0.00236 |
| `deposit_and_register` | — | 1,000,000 | 9,021,200 | 8,223,732 | **1,797,468** | 0.00180 |
| `update_commitment_root` | — | 1,000,000 | 8,740,000 | 8,411,832 | **1,328,168** | 0.00133 |
| `propose_withdraw_vk` | — | 1,000,000 | 11,970,000 | 8,652,600 | **4,317,400** | 0.00432 |
| `create_compliance_config` | — | 1,000,000 | 14,698,400 | 8,411,832 | **7,286,568** | 0.00729 |
| `propose_compliance_toggle` | — | 1,000,000 | 8,990,800 | 8,893,368 | **1,097,432** | 0.00110 |
| `freeze_pool` | — | 1,000,000 | 11,726,800 | 11,609,532 | **1,117,268** | 0.00112 |
| `unfreeze_pool` | — | 1,000,000 | 11,726,800 | 11,609,532 | **1,117,268** | 0.00112 |
| `propose_withdrawal` | — | 1,000,000 | 12,030,800 | 11,609,532 | **1,421,268** | 0.00142 |
| **`shielded_transfer`** | 1 (transfer) | 1,000,000 | 14,242,400 | 12,369,456 | **2,872,944** | 0.00287 |
| **`zk_withdraw`** | 1 (withdraw) | 1,000,000 | 15,580,000 | 12,128,688 | **4,451,312** | 0.00445 |
| **`compliant_transfer`** | 2 (transfer + compliance) | 1,000,000 | 19,326,800 | 15,318,864 | **5,007,936** | 0.00501 |

The three proof-gated rows are real, on-chain-verified Groth16 proofs — not the dummy/zero proofs
the Move unit tests use for their (all-negative) `shielded_transfer` test cases. `shielded_transfer`
and `zk_withdraw` each perform one BN254 pairing check inside the transaction; `compliant_transfer`
performs two (transfer proof + compliance proof) in a single call.

**The finding that matters more than any single row: computation cost is identical — exactly
1,000,000 MIST (1,000 computation units at today's reference price) — for every single call above,
including the three that run a full Groth16/BN254 pairing verification.** Sui's gas-computation
metering buckets computation units coarsely; a native `groth16::verify` call and a no-op
`freeze_pool` land in the same minimum bucket on this protocol version. **Every gas difference
between entry points in the table above is entirely a storage-cost/rebate effect** — how many bytes
of new dynamic-field state a call writes (nullifiers, commitments, VK bytes) minus how much it frees.
This is a genuinely non-obvious result: on Sui, "does this transaction verify a SNARK" is gas-free
information — the cost signal is about state growth, not cryptographic work. `compliant_transfer`'s
extra ~2.1M MIST over `shielded_transfer` is the credential-nullifier dynamic field it additionally
writes (32 bytes) plus its compliance proof's own 192-byte public-input vector stored alongside the
224-byte transfer public-input vector — not "twice the compute," despite verifying twice the proofs.

Applied to `docs/threat-model.md` **D3** (griefing via fake commitments, mitigated by the
100/500/1000 TOKEN standard-deposit requirement): a `deposit_and_register` griefing attempt costs
the attacker **0.0018 SUI in gas** — three orders of magnitude below the cheapest standard deposit
(100 TOKEN). Gas is not, and was never going to be, the load-bearing part of that mitigation; the
token minimum is. Worth stating explicitly rather than assumed.

### Full raw output

Reproduce with (see `scripts/bench/onchain-gas.mjs`'s header comment for the complete prerequisite
list — CLI version matching, local network bootstrap, circuit compilation):

```
sui start --force-regenesis --with-faucet &
sui client new-env --alias local --rpc http://127.0.0.1:9000
sui client switch --env local
sui client faucet
cd scripts/bench && node onchain-gas.mjs
```

```
Active address: 0x3ee94c72a3015525ab48cd6019ee8838b231eb865b08fc3f0f8ef16591d81770
RPC: http://127.0.0.1:9000
Chain identifier: 523954ef

=== Generating withdraw proof (epoch-independent, safe to build now) ===

=== Publishing veil package to local network (sui client test-publish) ===
  [gas] publish (package publish): net 156807480 MIST (computation 1370000, storage 156415600, rebate 978120)
Package: 0x38fa7b7dbd952d360f64bad8c56189833c21ee983270c5eefdd9815d5d23dff8

=== create_pool (transfer_vk) ===
  [gas] create_pool (create_pool): net 8518680 MIST (computation 1000000, storage 8496800, rebate 978120)
Pool: 0x9aebe31d61f7914e7e009fa88bc49d9ba43666bce007259d12f84a0b80bc1fad  AdminCap: 0x313b36003b2e474f51b0d8ee7f377ab59b734c908e3cb050c1ce92ef8bd60e36

=== token_faucet::faucet (mint x3: transfer genesis, withdraw UTXO, pool #2 genesis) ===
  [gas] token_faucet::faucet (faucet mint (transfer genesis)): net 2364656 MIST (computation 1000000, storage 4043200, rebate 2678544)
  [gas] token_faucet::faucet (faucet mint (withdraw UTXO)): net 2364656 MIST (computation 1000000, storage 4043200, rebate 2678544)
  [gas] token_faucet::faucet (faucet mint (pool #2 genesis)): net 2364656 MIST (computation 1000000, storage 4043200, rebate 2678544)

=== deposit_and_register (transfer genesis commitment) ===
  [gas] deposit_and_register (deposit (transfer genesis)): net 1797468 MIST (computation 1000000, storage 9021200, rebate 8223732)

=== deposit_and_register (withdraw UTXO commitment) ===
  [gas] deposit_and_register (deposit (withdraw UTXO)): net 1797468 MIST (computation 1000000, storage 9021200, rebate 8223732)

=== update_commitment_root + propose_withdraw_vk (both timelocked 1 epoch) ===
  [gas] update_commitment_root (update_commitment_root): net 1328168 MIST (computation 1000000, storage 8740000, rebate 8411832)
  [gas] propose_withdraw_vk (propose_withdraw_vk): net 4317400 MIST (computation 1000000, storage 11970000, rebate 8652600)

=== Pool #2: create_pool + create_compliance_config + genesis deposit ===
  [gas] create_pool (create_pool #2): net 8518680 MIST (computation 1000000, storage 8496800, rebate 978120)
  [gas] create_compliance_config (create_compliance_config): net 7286568 MIST (computation 1000000, storage 14698400, rebate 8411832)
  [gas] deposit_and_register (deposit (pool #2 genesis)): net 1799900 MIST (computation 1000000, storage 9264400, rebate 8464500)
  [gas] update_commitment_root (update_commitment_root #2): net 1330600 MIST (computation 1000000, storage 8983200, rebate 8652600)
  [gas] propose_compliance_toggle (propose_compliance_toggle): net 1097432 MIST (computation 1000000, storage 8990800, rebate 8893368)
  [wait] sleeping 65s for pool epoch to roll over (timelocked updates apply lazily)...

=== Live on-chain epoch: 29828624 — generating epoch-correct proofs ===

=== shielded_transfer (real Groth16 verification on-chain) ===
  [gas] shielded_transfer (shielded_transfer): net 2872944 MIST (computation 1000000, storage 14242400, rebate 12369456)

=== zk_withdraw (real Groth16 verification on-chain) ===
  [gas] zk_withdraw (zk_withdraw): net 4451312 MIST (computation 1000000, storage 15580000, rebate 12128688)

=== Admin ops (freeze / unfreeze / propose_withdrawal) ===
  [gas] freeze_pool (freeze_pool): net 1117268 MIST (computation 1000000, storage 11726800, rebate 11609532)
  [gas] unfreeze_pool (unfreeze_pool): net 1117268 MIST (computation 1000000, storage 11726800, rebate 11609532)
  [gas] propose_withdrawal (propose_withdrawal): net 1421268 MIST (computation 1000000, storage 12030800, rebate 11609532)

=== compliant_transfer (transfer proof + compliance proof, both verified on-chain) ===
  [gas] compliant_transfer (compliant_transfer): net 5007936 MIST (computation 1000000, storage 19326800, rebate 15318864)
```

(Full raw effects blocks are in `scripts/bench/onchain-gas-results.json`, generated fresh by every
run — not committed, since it's regenerable output rather than source.)

**Reproducibility note.** I ran this script twice, back to back, on the same `--force-regenesis`
network's *second* genesis (the network itself was restarted between runs; each run publishes its
own fresh package). Every row reproduced exactly except the very first `create_pool` call: 4,606,200
MIST on the first run's freshest-possible chain state, 8,518,680 MIST on the second run and on
*every subsequent* `create_pool` call in both runs (pool #2 in run 1 already showed 8,518,680). The
delta is entirely in `storageRebate` (4,890,600 vs. 978,120) — plausibly a one-time effect of Sui's
storage fund being smaller immediately after genesis than after a handful of prior transactions have
paid storage fees into it. The table above reports the *stable* value (8,518,680), since it's what
every `create_pool` call after the first one on a live network will actually cost; the one-off
genesis-adjacent number is noted here rather than silently discarded. Every other row — including
both proof-gated `shielded_transfer`/`zk_withdraw` calls and `compliant_transfer` — matched to the
byte across both runs.

### Toolchain-unblocking commands (raw output)

```
$ curl -sS -L -o sui.tgz -w "HTTP:%{http_code} SIZE:%{size_download}\n" \
    "https://github.com/MystenLabs/sui/releases/download/testnet-v1.72.1/sui-testnet-v1.72.1-ubuntu-x86_64.tgz"
HTTP:200 SIZE:1045872059

$ sui --version
sui 1.72.1-94ad8ccd0ed6

$ cd contracts && sui move build   # (no longer fails once CLI/framework versions match)
...
BUILDING veil
[warnings only — no errors]

$ sui move test
Test result: OK. Total tests: 124; passed: 124; failed: 0
```

### Full test suite (green, run before opening this PR)

| Suite | Result | Command |
|---|---|---|
| Move contracts | **124/124 pass** (previously BLOCKED — see above) | `cd contracts && sui move test` |
| Circuits (real Groth16 proofs) | **108/108 pass** (43 transfer + 30 compliance + 35 withdraw) | `node --experimental-vm-modules test/{transfer,compliance,withdraw}.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Fuzz properties | **6/6 pass** (500 runs each, 3,000 total) | `cd scripts && bun run src/fuzz-tests.ts` |
| Frontend types | **clean** | `cd frontend && bunx tsc --noEmit` |
| Frontend tests | **19/19 pass** | `cd frontend && bunx vitest run` |
| Frontend lint | **tooling broken, pre-existing, unrelated** — see note | `cd frontend && bunx biome check .` |

**Frontend lint note (discovered, not fixed tonight — out of scope for this experiment's
hypothesis):** `frontend/package.json`'s `lint` script runs `bunx biome check .`, but
`@biomejs/biome` is not declared as a dependency anywhere in the repo. `bunx biome` (unscoped)
resolves to an unrelated npm package also named `biome` (v0.3.3 — not the formatter/linter), which
silently does nothing. Running the *real* tool explicitly
(`bunx @biomejs/biome@2.0.0 check .`) fails immediately on `biome.json`'s schema — the config file
uses biome 1.x keys (`files.ignore`) that 2.x renamed. So CI's own `frontend-tests` job
(`.github/workflows/ci.yml` runs this exact `bunx biome check .` command) has silently never run
real linting, on any PR, ever. Filed in `EXPERIMENTS.md` as a tooling papercut, same treatment as
2026-07-22's `circuits` `npm test` hang.

No test was loosened, skipped, or given new tolerance to reach these results.

## Verdict: **KEEP**

`BASELINE.md`'s on-chain-gas row and Move-test-suite row are updated with these real numbers,
closing both gaps the 2026-07-22 baseline left BLOCKED. `EXPERIMENTS.md` item #1 is settled and
removed from the queue.

## Where this could be used

- **Any Sui Move protocol budgeting relayer/sponsor economics** — the finding that Groth16
  verification is computation-gas-free on Sui (cost is 100% storage-driven) generalizes to any
  `sui::groth16`-based verifier, not just Veil's three circuits. A protocol deciding whether to batch
  proofs to save gas should model the savings as *storage* savings (fewer dynamic fields, smaller
  public-input vectors), not compute savings — batching won't move the computation-cost needle at all
  on this gas schedule.
- **A thesis chapter on SNARK-verification economics across chains** — "pairing checks are gas-free
  relative to state writes" is a Sui-specific (bucketed computation-cost model) result worth
  contrasting against Ethereum, where an L1 pairing precompile call has a large, linearly-billed gas
  cost. That contrast is a clean comparative data point.
- **Confidential payroll or compliance-gated DeFi on Sui** — `compliant_transfer`'s real
  ~0.005 SUI/call number is what a t-of-n auditor-board deployment (2026-07-22's queued use case)
  needs to budget per-transfer compliance overhead honestly, instead of guessing from constraint
  counts.

## Open questions (next queue)

1. **Poseidon2 vs current Poseidon** (already `EXPERIMENTS.md` #2, now #1) — this baseline gives it
   a real gas number to *also* check against, not just constraint count / proving time: does a
   smaller proof or fewer public-input bytes move `shielded_transfer`'s storage-dominated gas cost
   at all, or is the storage floor set by the nullifier/commitment dynamic fields regardless of
   circuit size?
2. **The Sui computation-cost bucketing itself** — worth confirming whether *any* single Move call
   can exceed the minimum 1,000-unit bucket, and if so what it takes (loop-heavy Move logic? a much
   larger native crypto call?). If nothing in Veil's contracts ever leaves the minimum bucket, that's
   worth stating as a standing property, not re-discovering by accident on a future gas-focused night.
3. **`frontend`'s broken lint tooling** (see Results note) — low priority, same bucket as the
   2026-07-22 `npm test` hang: a real papercut, not urgent, fold into a future night that's already
   touching `frontend/`.
4. Batched/aggregated proof verification (`EXPERIMENTS.md`, was #3) can now use real per-verify gas
   numbers (2,872,944 MIST for one `shielded_transfer`) as its baseline instead of waiting on this
   experiment — no longer blocked on item #1.
