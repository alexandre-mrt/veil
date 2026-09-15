# 2026-09-15 — On-chain gas per entry point (queue item #1)

## Hypothesis

`BASELINE.md`'s one remaining unmeasured axis — real Sui gas cost per Move entry point
(`deposit_and_register`, `shielded_transfer`, `zk_withdraw`, `compliant_transfer`, and admin ops)
— can be measured directly, with real `gasUsed` from real transaction effects, by standing up a
fully local `sui` network and driving it with real Groth16 proofs, instead of needing a public
testnet fullnode (blocked twice before — see `LEDGER.md` 2026-07-22). This experiment moves that
axis from **BLOCKED** to **measured**, and specifically tests whether Groth16 verification cost
(as opposed to storage writes) is what dominates gas for the proof-carrying entry points — the
number `EXPERIMENTS.md` item #3 (batched proof verification) needs before it can be evaluated
honestly.

## Threat / privacy model

No protocol code changed — no circuit, no Move module logic. This is a measurement night. The
relevant framing is the same one 2026-07-22 used: **who relies on these numbers, and what breaks
if they're wrong.**

- **This research loop**, on every future scalability night: `EXPERIMENTS.md` item #3 (batched
  proofs) and item #4 (Merkle accumulator at scale, which touches gas via indexer/insertion cost)
  are both diffs against this number. A guessed or stale gas baseline makes both comparisons
  silently wrong.
- **`docs/threat-model.md` D3** ("Spam pool with fake commitments to exhaust dynamic fields") cites
  "minimum cost of 100 TOKEN per griefing attempt" as the deterrent — that claim has never had a
  real gas number attached to the *transaction* cost of the griefing attempt itself, only the
  token-denomination cost. This experiment supplies it (see Results): a `deposit_and_register`
  costs ~0.0031 SUI in net gas, several orders of magnitude below the 100-token deposit itself, so
  D3's mitigation is (and was always) about the *token* cost, not the *gas* cost — worth being
  explicit about, since a reader could otherwise assume gas was the deterrent.
- **A protocol integrator or thesis reader** estimating what a Veil-shaped transfer actually costs
  end users on Sui mainnet needs real per-entry-point numbers, not a guess extrapolated from
  constraint counts (constraint count drives *proving* time, not *verification* gas — see
  Approach).

What this does **not** establish: mainnet gas prices, reference gas price fluctuation under real
network load, or gas cost under object contention (this ran against a single-validator local
network with no concurrent traffic — relevant to `EXPERIMENTS.md` item on shared-object contention
under concurrent transfers, still unmeasured). It does not change any STRIDE entry's mitigation
status; it only attaches a real number to D3's existing "Mitigated" claim. Assumptions carried over
unchanged: Groth16/BN254 soundness, the dev-only trusted setup (RR2, and this run's own local ptau
— see Approach — is if anything *more* dev-only, not less, so RR2's status is unaffected).

## Approach

**What I built.**

- `scripts/bench/gas-baseline.mjs` — a new, reusable, self-contained bench script (plain Node, no
  bun dependency — see below) that: stands up against whatever `sui` network is active, deploys
  the real Veil package, creates a pool, deposits real commitments, proposes and waits out the real
  1-epoch timelocks for a commitment-root update and a withdraw-VK update, generates real Groth16
  proofs for `transfer`, `withdraw`, and `compliance` (via `snarkjs.groth16.fullProve` against the
  actual compiled circuits), and calls every gas-relevant entry point — `deposit_and_register`,
  `update_commitment_root`, `propose_withdraw_vk`, `shielded_transfer`, `zk_withdraw`,
  `create_compliance_config`, `compliant_transfer`, `freeze_pool`, `unfreeze_pool` — recording the
  exact `gasUsed` (`computationCost`, `storageCost`, `storageRebate`) from each transaction's
  effects. Epoch-dependent circuit inputs (`epochId`/`currentEpoch`) are computed from the *live*
  on-chain clock at proof-generation time rather than hardcoded, since a real validator's clock
  moves in real wall-clock time and a stale constant would just fail `E_EPOCH_MISMATCH`.
- Two small, genuine bug fixes in existing infra, found while wiring this up (see below):
  `scripts/src/deploy.ts` was extracting a *package object's* digest and calling it the
  *transaction* digest (an object digest and a transaction digest are different things on Sui; the
  former 404s against `getTransactionBlock`), and it only ever tried `sui client publish`, which
  the currently-available Sui CLI (1.79.0) refuses whenever `Move.toml` has no `[environments]`
  entry for the active network (veil's `Move.toml` predates that CLI feature). Both are fixed in
  place; `deploy.ts` now falls back to `sui client test-publish --build-env <active>` when
  `publish` reports the missing-environment error, and reads the real top-level `digest` field.

**Toolchain: what was blocked before, and how it got unblocked tonight.**

`EXPERIMENTS.md`'s note from 2026-07-22 was direct: this axis was blocked twice, for different
reasons, and "worth spending an early part of the next run purely on unblocking the toolchain
before attempting the measurement." That's what most of tonight was:

1. **`sui` CLI, take two.** Building it from source (`cargo build`) is still impractical in one
   night — it's a large multi-crate workspace. But this session's network policy turned out to
   allow direct `https://github.com/.../releases/download/...` asset downloads (redirecting to
   `release-assets.githubusercontent.com`), which 2026-07-22 either didn't try or hit differently.
   Downloaded the prebuilt `sui-testnet-v1.79.0-ubuntu-x86_64.tgz` release tarball (~1.1 GB),
   extracted just the `sui` binary. `sui --version` → `sui 1.79.0-46f18562f1f5`.
2. **Public fullnode RPC — confirmed still blocked, for everyone.** Tried
   `fullnode.testnet.sui.io`, `sui-testnet.blockvision.org`, `sui-testnet-rpc.publicnode.com`,
   `testnet.suiet.app`, `rpc-testnet.suiscan.xyz`, `sui-testnet.public.blastapi.io` — every one
   rejected by the egress proxy with `connect_rejected` (`gateway answered 403 to CONNECT`). This
   isn't a per-host fluke; it reads as a deliberate category block on blockchain-RPC-shaped hosts
   (`github.com`, `crates.io`'s index/static endpoints, and npm all work fine through the same
   proxy). So the `suix_queryTransactionBlocks`-against-a-public-fullnode fallback item #1 named is
   confirmed genuinely closed, not just unlucky — the real fix had to route around needing any
   public Sui RPC at all.
3. **The actual unblock: a fully local network.** `sui start --network.config <dir> --with-faucet`
   runs a complete single-validator Sui network — consensus, a fullnode, JSON-RPC on `127.0.0.1:9000`,
   a faucet — with zero external network dependency once the binary exists. Genesis funds a local
   address with a large SUI balance directly, so no faucet call over the network is even needed.
   This sidesteps the RPC block entirely rather than working around it.
4. **`circom` and a `ptau`, same as 2026-07-22, plus one difference.** Built `iden3/circom` v2.2.2
   from source again (fast, ~1 minute). The Hermez `pot15_final.ptau` download
   (`storage.googleapis.com`) is blocked by the same category policy this time (it wasn't on
   2026-07-22 — network policy is evidently not static run-to-run). Rather than block on it,
   generated a fresh local Powers-of-Tau ceremony instead: `snarkjs powersoftau new bn128 15` →
   `contribute` → `prepare phase2`, entirely offline. This is not a materially different trust
   assumption from what `compile.sh` already does — both are single-contributor, dev-only, and
   explicitly non-production (see `docs/threat-model.md` RR2, unchanged).
5. **`sui client publish` itself needed a workaround** — see the `deploy.ts` fix above.

**What I rejected.** Considered trying to reach a public fullnode through a different transport
(a third-party RPC aggregator, a proxy-of-a-proxy) — rejected: the block is clearly policy, not a
single flaky host, and routing around an explicit network policy rather than working within it is
the wrong instinct even where technically possible. A fully local network is strictly better
anyway: it's reproducible by anyone, on any machine, with no dependency on a specific testnet
deployment's state or a third party's uptime.

**One design choice worth flagging:** `pool.move`'s `epoch_duration_ms` has a hard minimum of
60 seconds (`E_INVALID_EPOCH_DURATION`), and both the commitment-root update and the withdraw-VK
update are timelocked to the *next* epoch. So the bench script genuinely waits out two real
60-second-plus windows (polling the on-chain clock, not a fixed sleep) — this is why the run takes
several real minutes end-to-end, not proving or verification time (proving is sub-second per
circuit; see 2026-07-22's numbers, unchanged tonight).

## Results

### Gas per entry point (local single-validator network, `sui 1.79.0`, real Groth16 proofs)

| Entry point | Computation (MIST) | Storage (MIST) | Rebate (MIST) | **Net (MIST)** | Net (SUI) |
|---|---:|---:|---:|---:|---:|
| `pool::create_pool` | 1,000,000 | 8,496,800 | 978,120 | 8,518,680 | 0.00852 |
| `token_faucet::faucet` | 1,000,000 | 4,043,200 | 2,678,544 | 2,364,656 | 0.00236 |
| `pool::deposit_and_register` | 1,000,000 | 10,358,800 | 8,223,732 | 3,135,068 | 0.00314 |
| `pool::update_commitment_root` | 1,000,000 | 8,740,000 | 8,411,832 | 1,328,168 | 0.00133 |
| `pool::propose_withdraw_vk` | 1,000,000 | 11,970,000 | 8,652,600 | 4,317,400 | 0.00432 |
| **`pool::shielded_transfer`** | 1,000,000 | 14,242,400 | 12,369,456 | **2,872,944** | 0.00287 |
| **`pool::zk_withdraw`** | 1,000,000 | 15,580,000 | 12,128,688 | **4,451,312** | 0.00445 |
| `compliance::create_compliance_config` | 1,000,000 | 18,171,600 | 11,609,532 | 7,562,068 | 0.00756 |
| **`compliance::compliant_transfer`** | 1,000,000 | 22,800,000 | 18,749,808 | **5,050,192** | 0.00505 |
| `pool::freeze_pool` | 1,000,000 | 11,970,000 | 11,850,300 | 1,119,700 | 0.00112 |
| `pool::unfreeze_pool` | 1,000,000 | 11,970,000 | 11,850,300 | 1,119,700 | 0.00112 |
| *(package `publish`, one-time)* | 1,370,000 | 156,415,600 | 978,120 | 156,807,480 | 0.15681 |

The three proof-carrying transfer paths — the ones this axis exists to measure — bolded above.
`compliant_transfer` (two Groth16 verifications + more state) costs **1.76x** a plain
`shielded_transfer` (one verification), not 2x — consistent with the computation-cost finding
below.

**The headline finding: computation cost is flat at exactly 1,000,000 MIST for every single
transaction above, transfer-proof-verification included, publish excepted.** `shielded_transfer`
(one Groth16 verify against a 6,470-non-linear-constraint circuit) and `unfreeze_pool` (no
cryptography, one boolean flip) report identical `computationCost`. This is not a measurement
artifact — it's real and it's Groth16 doing exactly what Groth16 is designed to do:
**verification cost is O(number of public inputs), not O(constraint count)** — three fixed
pairings plus one group-scalar multiplication per public input, totally independent of how large
the circuit that produced the proof was. All three circuits have 5–7 public inputs; none of them
push verification out of Sui's cheapest computation bucket. **The 6,470 vs. 1,465 non-linear
constraint gap between `transfer.circom` and `withdraw.circom` (BASELINE.md) changes proving time
by 3x — it changes on-chain verification gas by nothing.**

What actually varies between entry points is **storage**: new dynamic fields (one per nullifier,
one per commitment), new shared objects (`ComplianceConfig`), and the size of the call's own
arguments (a 128-byte proof + 224-byte public inputs for `compliant_transfer`'s two proofs is
meaningfully more calldata than `freeze_pool`'s). The large rebates (typically 70–90% of storage
cost) are standard Sui accounting — mutating a shared object refunds the storage fee paid for its
previous version — and the *net* column above is the number that matters for comparison.

Raw command and (representative) output:

```
$ ./sui --version
sui 1.79.0-46f18562f1f5

$ node bench/gas-baseline.mjs
[gas-baseline] address: 0xf01055cb5bd21c35d29e62f4a69b478e9c99160efb98f433c8f1434074e44b2d
[gas-baseline] balance: 149999999346618264 MIST
[gas-baseline] publishing package...
[deploy] publish requires a declared environment; falling back to test-publish --build-env localnet
[deploy] Package published: 0x7f722db19f21db0e0e3af2ba70a8e55811d74b2ae994e29147e735d694cdb279
[gas-baseline] gas[publish] computation=1370000 storage=156415600 rebate=978120 net=156807480
[gas-baseline] create_pool...
[gas-baseline] gas[create_pool] computation=1000000 storage=8496800 rebate=978120 net=8518680
[gas-baseline] pool: 0x14a5dd658b5695497037e598203a2793bbb9393ca0b366cacdf15561cb1ebefd adminCap: 0xae947b372c56efa952db0fbbd1323b0d71465c4d6559855194aee37122d4d665
[gas-baseline] gas[token_faucet::faucet] computation=1000000 storage=4043200 rebate=2678544 net=2364656
[gas-baseline] gas[deposit_and_register] computation=1000000 storage=10358800 rebate=8223732 net=3135068
[gas-baseline] gas[deposit_and_register (withdraw commitment)] computation=1000000 storage=10358800 rebate=8223732 net=3135068
[gas-baseline] gas[update_commitment_root] computation=1000000 storage=8740000 rebate=8411832 net=1328168
[gas-baseline] gas[propose_withdraw_vk] computation=1000000 storage=11970000 rebate=8652600 net=4317400
[gas-baseline] waiting for pool epoch >= 29824287 (currently 29824286) [commitment root + withdraw VK + deposit maturity]...
[gas-baseline] epoch 29824287 reached [commitment root + withdraw VK + deposit maturity]
[gas-baseline] gas[shielded_transfer] computation=1000000 storage=14242400 rebate=12369456 net=2872944
[gas-baseline] gas[zk_withdraw] computation=1000000 storage=15580000 rebate=12128688 net=4451312
[gas-baseline] gas[deposit_and_register (compliant-transfer commitment)] computation=1000000 storage=13588800 rebate=11421432 net=3167368
[gas-baseline] gas[create_compliance_config] computation=1000000 storage=18171600 rebate=11609532 net=7562068
[gas-baseline] gas[update_commitment_root (compliant-transfer root)] computation=1000000 storage=12213200 rebate=11850300 net=1362900
[gas-baseline] waiting for pool epoch >= 29824291 (currently 29824290) [compliant-transfer commitment root]...
[gas-baseline] epoch 29824291 reached [compliant-transfer commitment root]
[gas-baseline] gas[compliant_transfer] computation=1000000 storage=22800000 rebate=18749808 net=5050192
[gas-baseline] gas[freeze_pool] computation=1000000 storage=11970000 rebate=11850300 net=1119700
[gas-baseline] gas[unfreeze_pool] computation=1000000 storage=11970000 rebate=11850300 net=1119700
[gas-baseline] wrote /home/user/veil/scripts/bench/gas-baseline-results.json
```

Full raw output (every field, every transaction digest) is in
`scripts/bench/gas-baseline-results.json`, written by the script itself, not hand-transcribed.

### Toolchain unblock evidence (queue item #1's actual blocker)

```
$ curl -sS -o /dev/null -w "%{http_code}\n" https://fullnode.testnet.sui.io
000  (curl: (56) CONNECT tunnel failed, response 403 — connect_rejected, organization policy)

$ curl -sS -I -L https://github.com/MystenLabs/sui/releases/download/testnet-v1.79.0/sui-testnet-v1.79.0-ubuntu-x86_64.tgz
HTTP/1.1 302 Found
Location: https://release-assets.githubusercontent.com/...sui-testnet-v1.79.0-ubuntu-x86_64.tgz

$ sui start --network.config /root/.sui-local-config --with-faucet=0.0.0.0:9123 &
$ curl -sS -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}' http://127.0.0.1:9000
{"jsonrpc":"2.0","id":1,"result":"2303ee27"}
```

### Full test suite (per README.md's documented commands — no CLAUDE.md exists in this repo)

| Suite | Result | Command |
|---|---|---|
| Move contract | **124/124 pass** | `cd contracts && sui move test` |
| `transfer.circom` (real Groth16) | **43/43 pass** | `cd circuits && node test/transfer.test.mjs` |
| `compliance.circom` (real Groth16) | **30/30 pass** | `cd circuits && node test/compliance.test.mjs` |
| `withdraw.circom` (real Groth16) | **35/35 pass** | `cd circuits && node test/withdraw.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Property-based fuzz | **6/6 properties, 500 cases each** | `cd scripts && bun run src/fuzz-tests.ts` |

The Move suite (124/124) was itself unreachable before tonight — this is the first time it has run
in this loop. No test was loosened, skipped, or given new tolerance.

## Verdict: **KEEP**

`docs/research/BASELINE.md`'s "on-chain gas per entry point" row moves from **BLOCKED** to
**measured**, with real numbers for every gas-relevant entry point, not just the three named in the
original queue item. `scripts/bench/gas-baseline.mjs` is a reusable script — anyone can
`sui start --force-regenesis --with-faucet` (or `sui genesis -f --with-faucet` + `sui start`) and
re-run it to reproduce or re-baseline after a circuit or contract change. The `deploy.ts` fixes
(real transaction digest, current-CLI-compatible publish) are genuine bugs, not scoped narrowly to
this experiment, and now unblock any future night that needs to deploy and measure on-chain
behavior — which is most of the remaining queue (items #3, #4, #11).

## Addendum (same night, discovered while driving this PR's CI to green)

This PR's CI came back red on 3 of 4 jobs immediately after opening — not from anything in this
diff, but from two pre-existing, base-branch failures (a corrupted `oven-sh/setup-bun` action pin;
a `storage.googleapis.com` ptau download now returning 403). Both are fixed in
`.github/workflows/ci.yml` as part of this PR (see the commit), reusing fixes already independently
derived and verified on two other unmerged branches (PR #55, PR #62) rather than re-deriving them.

Tracing why those fixes existed but were never merged surfaced something much more important than
a CI flake: **this repo has 60+ open, unmerged research/CI PRs, and nothing has landed since
2026-07-22** — the exact process failure `docs/research/2026-09-06-ci-backlog-audit.md` (PR #55)
already diagnosed. Two direct consequences for *this* PR:

1. **This experiment duplicates PR #59** (2026-09-11, `onchain-gas-baseline`) — same hypothesis,
   same headline finding (verification computation gas is flat; storage dominates), independently
   re-derived because PR #59 was never visible from the `main` this session started from. The
   measurement above is still real and independently verified, and the specific reusable script and
   two `deploy.ts` bugs are this session's own, but the *finding* is not new as of tonight.
2. **PR #59 also contains a Critical, unfixed vulnerability this session had not found on its
   own**: `pool::zk_withdraw` never checks its `recipient` argument against the proof's
   `recipientHash` public input — a relayer or front-runner can redirect any pending withdrawal's
   payout to their own address using someone else's valid proof. Verified directly against current
   `main` (`contracts/sources/pool.move:571-632`) rather than taken on faith from an unmerged PR's
   description. Documented here as `docs/threat-model.md` **RR10** and the **E7** STRIDE entry
   corrected (it previously, incorrectly, said this was "Mitigated"), and promoted to #1 in
   `EXPERIMENTS.md`. **Not fixed in this PR** — that needs a decided address-to-field-element
   encoding, an on-chain check, a soundness argument, and a negative test, which don't belong in a
   CI-triage/gas-measurement PR, and the person merging this should treat it as the actual priority
   over anything else in the queue.

This changes the verdict framing above: **KEEP** still stands for the gas numbers, the reusable
script, and the `deploy.ts`/CI fixes — but the highest-value output of tonight's run turned out to
be re-surfacing a stuck Critical security finding and a 60-PR merge backlog, not new research.

## Where this could be used

- **Any Circom/Groth16-on-Sui protocol's gas-cost documentation** — the finding that Groth16
  verification gas is public-input-count-bound, not constraint-count-bound, is protocol-agnostic:
  it applies to any team estimating mainnet cost from a constraint count alone (a common mistake —
  constraint count is the *prover's* problem, not the *verifier's*). It also means **storage**, not
  verification computation, is where a batching or scaling effort should focus first.
- **A thesis chapter's cost model for confidential-transfer protocols on Sui** — this table is a
  directly citable, reproducible "cost of privacy" number: a shielded transfer costs ~0.0029 SUI
  more in net gas than a plain Coin transfer would (not measured here, but a fair baseline
  reference — a plain `sui::transfer::public_transfer` has no proof-verification storage or
  dynamic-field writes), while a compliance-gated transfer (confidential payroll, KYC-gated
  transfers with a t-of-n auditor board — `EXPERIMENTS.md` item #6) costs about 1.76x that again.
- **This CI/research environment's network policy itself** — the working combination (GitHub
  release assets + git clone + crates.io index/static reachable directly, public RPC/blockchain
  hosts blocked as a category, `sui start` sidesteps it entirely) is worth remembering verbatim for
  any future night that needs a chain toolchain: don't re-attempt public RPC, go straight to a
  local network.

## Open questions (next queue)

1. **Batched/aggregated proof verification (`EXPERIMENTS.md` item #3), re-scoped by tonight's
   finding.** Since verification computation is already in Sui's cheapest bucket regardless of
   circuit size or proof count (`compliant_transfer`'s two verifications cost the same
   *computation* as one), batching N transfers into one verification mainly saves the **storage**
   cost of N separate dynamic-field writes and N separate transaction envelopes — not computation.
   A real batching design needs to change *how* nullifiers/commitments are stored (e.g., a single
   batched write instead of N dynamic fields) to actually move this number; naively wrapping
   today's per-transfer storage pattern in one bigger transaction would save little. Worth
   confirming with a real 2-transfer-in-one-PTB measurement before designing anything bigger.
2. **Gas under real concurrent load / shared-object contention** — tonight's numbers are from a
   single-validator network processing transactions one at a time, no contention on the shared
   `Pool` object. Real mainnet gas (and, more importantly, transaction *latency* under contention)
   for concurrent transfers against the same pool is still unmeasured.
3. ~~Does the local-ptau-vs-downloaded-Hermez-ptau substitution matter for anything beyond this
   run?~~ **Resolved same night** (see Addendum): the Hermez URL is unreachable for the CI runner
   too, not just this session's sandbox, and PR #62 (2026-09-14, unmerged before tonight) already
   made `circuits/scripts/compile.sh` fall back to local `snarkjs powersoftau` generation. This PR
   ports the same fix into `.github/workflows/ci.yml`.
4. **`deploy.ts`'s `test-publish` fallback leaves an ephemeral `Pub.<env>.toml` per run** (now
   `.gitignore`d and cleaned automatically before each publish attempt) — fine for a one-shot bench
   script, but worth confirming this doesn't surprise a human running `deploy.ts` interactively and
   expecting a persistent `Published.toml`-style record.
5. **The merge backlog itself is now the single highest-leverage thing anyone could fix** (see
   Addendum) — every other open question in every unmerged report, this one included, stays
   theoretical until something merges. Who reviews/merges these PRs, and on what cadence? If the
   honest answer is "no one, currently," fixing CI (this PR, #55, #62) doesn't fix the actual
   bottleneck.
