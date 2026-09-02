# 2026-09-02 — On-chain gas per entry point (queue item #1)

## Hypothesis

Real Sui gas cost — `effects.gasUsed` from actual transaction execution, not an estimate — can be
measured for every Veil entry point (`deposit_and_register`, `shielded_transfer`, `zk_withdraw`,
`compliant_transfer`, and the admin operations) in one run on one machine, closing the one axis
`BASELINE.md` left BLOCKED on 2026-07-22. This experiment moves "on-chain gas per entry point" from
BLOCKED to a 20-row table of real numbers, and — as a direct consequence of getting a working `sui`
CLI — also closes a second BLOCKED item from the same night: the 124-test Move contract suite had
never been run.

## Threat / privacy model

Same framing as the 2026-07-22 baseline: no circuit, Move module, or proof format changed tonight.
This is a measurement night. The question is who relies on these numbers being honest.

- **This research loop**, on future nights: queue item #3 (batched/aggregated proof verification —
  "N transfers → 1 on-chain verify") was explicitly blocked on "a real per-verify gas number to know
  how much this would actually save." That number now exists (`shielded_transfer`: 2,875,376 MIST net;
  `compliant_transfer`, which verifies *two* Groth16 proofs: 5,050,192 MIST net — see Results). Queue
  item #4 (Merkle accumulator at scale) similarly needs a real `update_commitment_root` cost as its
  baseline; that now exists too (1,362,900 MIST net).
- **`docs/threat-model.md` D3** ("Spam pool with fake commitments to exhaust dynamic fields") currently
  cites only the TOKEN-denominated cost floor (100/500/1000 TOKEN per `deposit_and_register`). That's
  a real cost, but it's a griefing *deposit*, not a griefing *fee* — the attacker gets the TOKEN back
  in the commitment (it isn't burned). The actual per-attempt cost floor a griefer can't recover is the
  **SUI gas** paid to submit the transaction: 1,832,200 MIST (~0.0018 SUI) net, measured tonight. That's
  the number D3's mitigation was missing.
- **A protocol integrator or thesis reader** citing "Veil's `shielded_transfer` costs ~X gas" should be
  able to reproduce the same order of magnitude. Reproducibility is the deliverable, as with the
  2026-07-22 baseline.

What this does **not** establish: whether these costs are *competitive* with other privacy protocols on
Sui or elsewhere (no comparison was attempted), or what gas costs would look like under real network
congestion / a non-unity reference gas price (this local network's reference gas price is the protocol
default, 1000 MIST/unit — see Results). It also says nothing new about soundness, privacy, or trust
boundaries — unchanged from 2026-07-22. Assumptions carried over unchanged: Groth16/BN254 soundness,
the dev-only trusted setup (RR2), and the local network's protocol config being representative of
testnet/mainnet gas pricing (same `sui` binary, same protocol version — see Approach for why this is a
reasonable stand-in for testnet, not testnet itself).

## Approach

**What I built.** `scripts/bench/onchain-gas.mjs` — a reusable, idempotent script that:

1. Publishes the real, unmodified `contracts/` package to whatever network the active `sui client` env
   points at.
2. Drives every pool/compliance entry point with a **real Groth16 proof** (transfer, withdraw, and
   compliance circuits — the same compiled artifacts and witness-construction pattern as the
   2026-07-22 `scripts/bench/witnesses.mjs`, extended here with live on-chain epoch binding — a fixed
   `epochId` doesn't work once the number has to match a real chain's clock, see below).
3. Records `effects.gasUsed` (computationCost, storageCost, storageRebate, nonRefundableStorageFee) for
   every call, printing one JSON line per entry point plus a final summary array.

**Unblocking the `sui` CLI (the queue's own instruction for tonight: "spend an early part of the next
run purely on unblocking the toolchain before attempting the measurement").** Two blockers, both
resolved:

1. **Network policy** (2026-07-22's blocker) is unchanged: `fullnode.testnet.sui.io` still returns a
   403 at the CONNECT layer (confirmed again tonight — `recentRelayFailures` in the proxy status
   endpoint), and so does `github.com/…/releases` and `api.github.com`. But **plain `git`-protocol
   HTTPS to `github.com` and the full `crates.io` ecosystem (sparse index *and* `static.crates.io`
   tarball downloads) are reachable** — untested in this shape on 2026-07-22, which only tried the
   GitHub *releases* API and a raw JSON-RPC POST, not `cargo install --git`. That's the actual
   unblock: `cargo install --locked --git https://github.com/MystenLabs/sui.git --branch testnet sui`
   builds cleanly over this transport (rustc and cargo were already present in this image, unlike
   circom on 2026-07-22).
2. **A real compile error**, not a network issue: the first attempt (system rustc 1.94.1) failed inside
   `consensus-core` — `flex_committer.rs:462`, `with_label_values(&[leader_host, "certified-commit"])`,
   `expected &[&String] found &[&str; 2]` — an array-literal type-inference case that this branch's own
   `rust-toolchain.toml` (pinned to `1.96.1`) evidently relies on. Installing `1.96.1` via `rustup` and
   rebuilding with `rustup run 1.96.1 cargo install …` compiled clean. Two builds, ~46 minutes each
   (release, single machine, 4 cores) — this is the real cost of "from-source build budgeted across
   more than one night" the queue anticipated, done in one night here.

**Local network instead of testnet, deliberately.** With a working CLI, the queue's other suggested
path — direct `suix_queryTransactionBlocks` reads against the deployed testnet package — was tried
first and hit the same network-policy wall (`fullnode.testnet.sui.io` still 403). Rather than a third
attempt at an already-twice-blocked host, I ran a **local Sui validator** (`sui start --with-faucet
--force-regenesis`) and published the real package there. This is not a downgrade: `effects.gasUsed`
comes from the same `sui-execution` code paths (same binary, same protocol version, same gas-pricing
formulas) that run on testnet — a local network is the standard way protocol teams get real gas numbers
during development, precisely because it needs no live network access.

**What I rejected.**
- *Publishing via `sui client publish`* — refuses to build against the `local` client environment
  because `contracts/Move.toml` only pins dependency addresses for `testnet` (see `contracts/Move.lock`).
  Rather than add a `local` environment to `Move.toml` (a persistent, unrelated change to a file used by
  the real testnet deployment flow), I used `sui client test-publish --build-env testnet
  --pubfile-path <scratch file>`: it builds against the testnet-pinned framework revision but
  *executes* the publish against whichever network is active — exactly what a local benchmark needs,
  with zero changes to `contracts/Move.toml`. `.gitignore` gained two lines for the ephemeral pubfile
  patterns this leaves behind (`contracts/Pub.*.toml`, `scripts/bench/.local-pubfile.toml`).
- *Running the benchmark under `bun`* (the convention for `scripts/src/*.ts`) — `circomlibjs`'s
  `buildPoseidon()` pulls in `ffjavascript`'s curve builder, which spawns a real `worker_thread` even
  when called with `singleThread: true`. Under bun 1.3.11 that worker crashes the process
  (`web-worker`'s Node shim throws inside the `parentPort` `'message'` handler — a bun/circomlibjs
  compatibility bug, not anything in this codebase; `node` has no such issue, same as
  `prove-latency.mjs` and the `circuits/test/*.test.mjs` suite). Rather than debug bun's worker
  polyfill, the script is plain node ESM (`scripts/bench/onchain-gas.mjs`), duplicating the ~150 lines
  of `proof-converter.ts` / `compliance-utils.ts` logic it needs rather than importing TypeScript
  across the node/bun boundary.
- *A fixed `epochId`* (`scripts/bench/witnesses.mjs`'s pattern, `epochId = 1n`) — `pool::current_epoch`
  is `floor(unix_ms / epoch_duration_ms)`, wall-clock-based, not pool-relative; a hardcoded epoch would
  never match a live chain's `on_chain_epoch ± 1` grace window. Every proof here reads the real epoch
  from the chain immediately before proving and submitting.
- *Reusing one `userSecret` for both the plain `shielded_transfer` leg and `compliant_transfer`'s
  internal transfer leg* — first attempt did this and hit `E_COMMITMENT_EXISTS`: with `txAmount`,
  `randomnessOld`, `randomnessNew` all fixed constants, the same `userSecret` produces the exact same
  `oldCommitment`/`newCommitment` on both legs, so the second `execute_transfer` tries to re-add a
  commitment the first one already created. Fixed by giving the compliance leg's transfer proof a
  distinct `userSecret`.
- A first pass also waited for the epoch to advance using the epoch **read before** the deposit/
  `update_commitment_root` calls, not after. Those are themselves real transactions on a live local
  network with consensus latency; by the time `update_commitment_root` actually executed, the epoch
  had already ticked forward, so its `effective_epoch` (`pool_epoch()+1` *at call time*) ended up one
  epoch later than the wait condition expected — the on-chain state showed `pending_commitment_root`
  still unapplied and `E_MERKLE_ROOT_MISMATCH`. Fixed by re-reading the epoch immediately after the
  setup calls, right before waiting.

## Results

### On-chain gas per entry point (local Sui network, real transactions)

Reference gas price: **1000 MIST/unit** (`suix_getReferenceGasPrice`, protocol default — same value
`sui start`'s local genesis and testnet currently use). "Net" = `computationCost + storageCost -
storageRebate`, i.e. what the caller actually pays after rebate; `nonRefundableStorageFee` is already
inside `storageCost` (the portion of a future rebate the protocol keeps), not an extra charge.

| Entry point | computationCost | storageCost | storageRebate | **net (MIST)** | net (SUI) |
|---|---:|---:|---:|---:|---:|
| `pool::create_pool` | 1,000,000 | 8,496,800 | 978,120 | **8,518,680** | 0.008519 |
| `compliance::create_compliance_config` | 1,000,000 | 14,941,600 | 8,411,832 | **7,529,768** | 0.007530 |
| `pool::propose_withdraw_vk` | 1,000,000 | 11,970,000 | 8,652,600 | **4,317,400** | 0.004317 |
| `pool::freeze_pool` | 1,000,000 | 11,970,000 | 11,850,300 | **1,119,700** | 0.001120 |
| `pool::unfreeze_pool` | 1,000,000 | 11,970,000 | 11,850,300 | **1,119,700** | 0.001120 |
| `pool::propose_vk_update` | 1,000,000 | 15,686,400 | 11,850,300 | **4,836,100** | 0.004836 |
| `pool::cancel_vk_update` | 1,000,000 | 11,970,000 | 15,529,536 | **−2,559,536** | −0.002560 |
| `pool::propose_withdrawal` | 1,000,000 | 12,274,000 | 11,850,300 | **1,423,700** | 0.001424 |
| `pool::cancel_withdrawal` | 1,000,000 | 11,970,000 | 12,151,260 | **818,740** | 0.000819 |
| `token_faucet::faucet` | 1,000,000 | 4,043,200 | 2,678,544 | **2,364,656** | 0.002365 |
| `pool::deposit_and_register` | 1,000,000 | 12,494,400 | 11,662,200 | **1,832,200** | 0.001832 |
| `pool::update_commitment_root` | 1,000,000 | 12,213,200 | 11,850,300 | **1,362,900** | 0.001363 |
| `pool::shielded_transfer` | 1,000,000 | 14,485,600 | 12,610,224 | **2,875,376** | 0.002875 |
| `pool::zk_withdraw` | 1,000,000 | 15,823,200 | 12,369,456 | **4,453,744** | 0.004454 |
| `compliance::compliant_transfer` | 1,000,000 | 22,800,000 | 18,749,808 | **5,050,192** | 0.005050 |

`token_faucet::faucet` and `pool::deposit_and_register` each ran 2–3 times with identical gas every
time (deterministic — no branching on input values that differ between calls); one row per entry point
above. Every `computationCost` is exactly 1,000,000 MIST regardless of entry point — computation cost on
Sui is charged by the reference gas price and a small fixed unit count for typical Move calls; the
*storage* cost is what actually varies with entry-point complexity (more dynamic fields written, longer
`vector<u8>` arguments).

Three findings worth flagging:
- **`compliant_transfer` (two Groth16 verifications: transfer + compliance) is not 2× `shielded_transfer`
  (one verification) — it's 1.76×** (5,050,192 vs 2,875,376). Verification cost itself is a small,
  roughly-fixed slice of the total; most of the difference is the extra state written (credential
  nullifier, `ComplianceVerifiedEvent`'s `encrypted_amount`). This is the concrete number queue item #3
  (batched proof verification) needs to reason about savings from — verification is *not* the dominant
  cost per additional proof, so batching N transfers into one verification saves less than N-1 full
  transfer-cost's worth of gas.
- **`cancel_vk_update` has negative net cost** — the rebate for freeing the `pending_vk` bytes
  `propose_vk_update` wrote exceeds the cancel call's own storage cost. Cancelling a proposed update is
  a real, cheap safety valve, gas-wise as well as timelock-wise.
- **`create_pool` (8,518,680 MIST) and `create_compliance_config` (7,529,768 MIST) are the two most
  expensive calls** — both allocate a new shared object plus large `vector<u8>` verification-key fields
  (232+ bytes minimum, `MIN_VK_LENGTH`). One-time setup cost, not a per-transfer cost.

Raw command and full output (`scripts/bench/onchain-gas.mjs`, one JSON line per call, `gasUsed` fields
as reported by `effects.gasUsed`):

```
$ sui --version
sui 1.79.0-46f18562f1f5

$ sui client active-env
local

$ node scripts/bench/onchain-gas.mjs
[bench] RPC: http://127.0.0.1:9000
[bench] address: 0x568a098023ab549bf14d627168d14ddf01edc9f5ea45efaa45363ade1d53fea5
[bench] balance: 999068354360 MIST
[bench] publishing package...
[bench] package: 0x7e88f115140d72830874163f8c1343065fa69b7c514959f16c43b90e28661fde
{"entryPoint":"pool::create_pool","digest":"CWCYL6WqBfpJso8iAQM89Xn7cFApwySeQCq2mUR8Ldyf","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"8496800","storageRebate":"978120","nonRefundableStorageFee":"9880"}}
[bench] pool: 0x3030bf19060b743c7b8bd14acf71b0fcb847b01da9018558435000b6e83b2c10
[bench] AdminCap: 0x8d7a3d10485a7016b4268c2e5f3027c4a3c1a3660340d8e6703acdb700b948fe
{"entryPoint":"compliance::create_compliance_config","digest":"9Jnfwy5zBwXfFx2xfZoXdo2dxtyyJgPxn8TTCeY1yTGS","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"14941600","storageRebate":"8411832","nonRefundableStorageFee":"84968"}}
[bench] ComplianceConfig: 0xf41e6177b8e17823c08a11c7ec6c9e2b5a0f9f2fe071dc7a38843675fe59e6bf
{"entryPoint":"pool::propose_withdraw_vk","digest":"F7wo4wKiEyBvovPBk1VuVts8Arrpv9KKFSEXtZtLGnAX","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"11970000","storageRebate":"8652600","nonRefundableStorageFee":"87400"}}
{"entryPoint":"pool::freeze_pool","digest":"FCQkPxDDTURrzscCemgRrUdmFBJift1UF4eyecmqC4um","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"11970000","storageRebate":"11850300","nonRefundableStorageFee":"119700"}}
{"entryPoint":"pool::unfreeze_pool","digest":"B8X54gJPAEbAjHdVU2HHEFF5rG95prhyUpiphJ3tBkU6","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"11970000","storageRebate":"11850300","nonRefundableStorageFee":"119700"}}
{"entryPoint":"pool::propose_vk_update","digest":"7rw6EXF6M2UufkdFzbtgZA85MtBCXF3zKxrBpbrKshPT","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"15686400","storageRebate":"11850300","nonRefundableStorageFee":"119700"}}
{"entryPoint":"pool::cancel_vk_update","digest":"6ae5ofmPTGdeuPLAZBw8YivVzHz7qvL85RKatzz9evT7","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"11970000","storageRebate":"15529536","nonRefundableStorageFee":"156864"}}
{"entryPoint":"pool::propose_withdrawal","digest":"Ek388mViZ5SA4LNcjS9hiLJ3hyaz17NLwEiCiQwoYirY","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"12274000","storageRebate":"11850300","nonRefundableStorageFee":"119700"}}
{"entryPoint":"pool::cancel_withdrawal","digest":"HUBUm4hp22HDE6quM1d8VUGHzSrox8zxahUHSH7pFkTq","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"11970000","storageRebate":"12151260","nonRefundableStorageFee":"122740"}}
{"entryPoint":"token_faucet::faucet","digest":"CGvM6yfFjinTHgMJEAw4dGhYK372tMpPo8LxwJ35tZGE","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"4043200","storageRebate":"2678544","nonRefundableStorageFee":"27056"}}
{"entryPoint":"token_faucet::faucet","digest":"ANWCtHHnnEoCEGWEJvuYwrWzr7zj4mBiSHhZ5UaKZvfA","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"4043200","storageRebate":"2678544","nonRefundableStorageFee":"27056"}}
{"entryPoint":"token_faucet::faucet","digest":"3R3ek64qR5aZn5TsTmG8m4WtYgzppMYfHJwGEL2SFdyT","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"4043200","storageRebate":"2678544","nonRefundableStorageFee":"27056"}}
{"entryPoint":"pool::deposit_and_register","digest":"313cCbNg332emiVvDJNz7K6ruf65E7Y5JHwYe4gco8Ho","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"12494400","storageRebate":"11662200","nonRefundableStorageFee":"117800"}}
{"entryPoint":"pool::deposit_and_register","digest":"5YF9mKLf1G6bih69oJL8uDbTAEviQpR4bPn8uZALTrFV","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"12494400","storageRebate":"11662200","nonRefundableStorageFee":"117800"}}
{"entryPoint":"pool::update_commitment_root","digest":"9EQz6BJ7azPtkSVorZgX7F29zNUtodDPvm6hpAihztqd","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"12213200","storageRebate":"11850300","nonRefundableStorageFee":"119700"}}
[bench] waiting for on-chain epoch to advance past 29805664 (epoch_duration_ms=60000)...
[bench] epoch advanced to 29805665
{"entryPoint":"pool::shielded_transfer","digest":"H5QetztAKuekFKbvVtUvf7jahfaAbbnDGPPSFFdDjgdq","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"14485600","storageRebate":"12610224","nonRefundableStorageFee":"127376"}}
{"entryPoint":"pool::zk_withdraw","digest":"3rEHNKrqWUuVE9RFU1q2DwDTXfPiQWM4orQ8uy2YAzP8","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"15823200","storageRebate":"12369456","nonRefundableStorageFee":"124944"}}
{"entryPoint":"pool::deposit_and_register","digest":"C7kc16u9hcYvpSXeWsMzp9vun47jsumYRTmYd3DxDvmu","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"12494400","storageRebate":"11662200","nonRefundableStorageFee":"117800"}}
{"entryPoint":"pool::update_commitment_root","digest":"5HaRhsyp8HMqwXigeruJJaykfjMBRs6jE1chXH7EvESN","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"12213200","storageRebate":"11850300","nonRefundableStorageFee":"119700"}}
[bench] waiting for on-chain epoch to advance past 29805665 (epoch_duration_ms=60000)...
[bench] epoch advanced to 29805666
{"entryPoint":"compliance::compliant_transfer","digest":"65hvicFnmfGUMPmezYZpoJpA8C65AFeiGwjHoMiN3nek","status":"success","gasUsed":{"computationCost":"1000000","storageCost":"22800000","storageRebate":"18749808","nonRefundableStorageFee":"189392"}}
```

### Toolchain unblock (raw)

```
$ cargo install --locked --git https://github.com/MystenLabs/sui.git --branch testnet sui
[... 45m46s in, real rustc 1.94.1 ...]
error[E0308]: mismatched types
   --> consensus/core/src/flex_committer.rs:462:42
    |
462 |                     .with_label_values(&[leader_host, "certified-commit"])
    |                      ------------------ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ expected `&[&String]`, found `&[&str; 2]`
error: could not compile `consensus-core` (lib) due to 2 previous errors

$ cat rust-toolchain.toml   # in the cloned sui checkout
[toolchain]
channel = "1.96.1"

$ rustup toolchain install 1.96.1
  1.96.1-x86_64-unknown-linux-gnu installed - rustc 1.96.1 (31fca3adb 2026-06-26)

$ rustup run 1.96.1 cargo install --locked --git https://github.com/MystenLabs/sui.git --branch testnet sui
   Finished `release` profile [optimized + debuginfo] target(s) in 45m 46s
   Installing /root/.cargo/bin/sui
   Installed package `sui v1.79.0 (https://github.com/MystenLabs/sui.git?branch=testnet#46f18562)` (executable `sui`)
```

### Full test suite (all previously-BLOCKED axes now closed)

| Suite | Result | Command |
|---|---|---|
| Move contracts | **124/124 pass** | `cd contracts && sui move test --build-env testnet` |
| `transfer.circom` (real Groth16) | **43/43 pass** | `node --experimental-vm-modules test/transfer.test.mjs` |
| `compliance.circom` (real Groth16) | **30/30 pass** | `node --experimental-vm-modules test/compliance.test.mjs` |
| `withdraw.circom` (real Groth16) | **35/35 pass** | `node --experimental-vm-modules test/withdraw.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |

124 Move tests were **BLOCKED** on 2026-07-22 for the identical reason as the gas number (no `sui`
CLI). No test was loosened, skipped, or given new tolerance. No circuit, Move module, or proof format
was changed tonight, so the circuit/converter/frontend suites are reproductions of already-green
results, not new coverage — included here because the queue's instruction is to run the *full* suite
before opening the PR, not just the axis this experiment adds.

## Verdict: **KEEP**

`docs/research/BASELINE.md`'s last BLOCKED axis (on-chain gas) now has 15 real, reproducible numbers,
and a second BLOCKED axis (the Move test suite) is closed as a direct side effect of the same toolchain
fix. `scripts/bench/onchain-gas.mjs` is a reusable script — re-running it against a fresh local network
reproduces the same numbers (gas pricing is deterministic given fixed inputs; the two nondeterministic
values, package/object IDs, don't affect cost).

## Where this could be used

- **Any Move-based ZK protocol's own gas-cost baseline** — the `test-publish --build-env <pinned-env>`
  trick for publishing to a local network without touching `Move.toml` is reusable for any package
  whose `Move.lock` only pins testnet/mainnet dependencies, which is the common case for a project that
  hasn't set up local-network CI.
- **A thesis chapter's cost-benchmark methodology** — "publish to a local validator with the same
  binary and protocol version as the target network" is a defensible substitute for live-network gas
  numbers when the target network itself is unreachable (rate-limited, access-controlled, or — as
  here — outside a sandboxed research environment's network policy), and is arguably *more*
  reproducible than a live-network snapshot subject to congestion-driven gas-price variation.
- **Confidential payroll or compliance-gated DeFi on Sui**: `compliant_transfer`'s 5,050,192 MIST
  (~0.005 SUI) — 1.76× a plain transfer despite verifying two proofs — is the number a protocol
  deciding between "always require compliance" vs "compliance above a threshold" (Veil's actual design)
  needs to quantify that design choice's gas cost, not just its privacy cost.

## Open questions (next queue)

1. **Batched proof verification (queue item #3)** is now unblocked — the real per-verify gas number
   exists. The next question it raises: since verification is a small slice of `compliant_transfer`'s
   extra cost over `shielded_transfer` (most of the 1.76× is state writes, not verification), does
   batching N *transfers* (not just N verifications) actually amortize the dominant cost, or does each
   transfer's own dynamic-field writes (nullifier, new commitment) dominate regardless of batching?
2. **Gas price sensitivity** — all numbers here use the protocol's default reference gas price (1000
   MIST/unit). Real testnet/mainnet gas prices fluctuate with validator stake-weighted votes; this
   experiment doesn't establish how these numbers move under a higher reference price.
3. Now that `sui` CLI works locally, is `suix_queryTransactionBlocks` against the **local** network
   (not the network-policy-blocked testnet host) a viable way to cross-check historical gas costs from
   a longer-running local scenario (e.g., 100 sequential transfers), rather than the fresh-publish
   single-call-per-entry-point shape used here?
4. `contracts/Move.toml` declares no `[environments]` table at all — only `Move.lock` has an implicit
   `testnet` pin. Should a `local` (or generic dev) environment be added to `Move.toml` so
   `sui client publish` works directly against a local network without the `test-publish --build-env`
   workaround? Worth doing if local-network testing becomes a recurring part of this loop.
