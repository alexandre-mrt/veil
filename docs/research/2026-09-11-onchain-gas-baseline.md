# 2026-09-11 — On-chain gas per entry point (queue item #1)

## Hypothesis

Every Veil entry point's real Sui gas cost — `publish`, `create_pool`, `propose_withdraw_vk`,
`token_faucet::faucet`, `deposit_and_register`, `update_commitment_root`, `shielded_transfer`
(real Groth16 transfer proof), `freeze_pool`/`unfreeze_pool`, and `zk_withdraw` (real Groth16
withdraw proof) — can be measured directly from `effects.gasUsed` on a real, running Sui network,
not estimated from constraint counts or a fee-schedule guess. This closes `BASELINE.md`'s one
remaining "Not yet measured" row, blocked on both of the last two nights this queue item came up
(see `LEDGER.md`, 2026-07-22) for lack of a `sui` CLI or network path to a fullnode.

This is a measurement night, not a protocol change: no circuit or Move source was modified.

## Threat / privacy model

Same framing as the 2026-07-22 baseline report: no adversary model changes from *measuring* gas.
The people who rely on these numbers being honest:

- **This research loop**, on every future night that touches gas: item 3 in the queue (batched
  proof verification) is explicitly a diff against the per-transfer `shielded_transfer` gas number
  measured here; a guessed baseline would make that diff meaningless.
- **Anyone deciding whether to sponsor transactions** (the relayer in `scripts/src/relayer.ts`,
  or a wallet operator) needs the real MIST cost per entry point, not a constraint-count proxy —
  gas is dominated by storage, not computation (see Results), which constraint count does not
  predict at all.

What this does **not** establish: whether these costs are *acceptable* for a real deployment
(no threshold is proposed here), what gas looks like under contention on a busy shared object (the
`Pool` is a single shared object every transfer touches — congestion pricing under concurrent load
is unmeasured, see Open questions and `docs/threat-model.md` DoS section), or anything about
mainnet gas pricing, which can differ from the reference gas price used here.

One genuine, unplanned finding surfaced while building the harness for this experiment: `zk_withdraw`
never checks that the on-chain `recipient: address` argument matches the `recipientHash` public
input the Groth16 proof actually commits to (`contracts/sources/pool.move:571-632` — see Open
questions #1 for the concrete mechanism). That *is* a privacy/soundness-relevant finding, so it gets
a full write-up there and a new residual risk entry, even though fixing it is out of scope for
tonight's one hypothesis (a fix would itself need a soundness argument and a negative test, which
this gas-measurement PR does not carry).

Assumptions carried over unchanged: Groth16 soundness under BN254 discrete-log, the dev-only
trusted setup (`docs/threat-model.md` RR2), and — newly relevant here — the fact that local-network
gas equals real-network gas for identical bytecode and inputs, because Sui's gas metering is
deterministic VM execution against a fixed, protocol-defined storage/computation price schedule,
not something a specific validator or network guesses per-transaction. Nothing about *that*
schedule is network-specific; what can differ between networks is only the reference gas price
(queried live here — see Approach) and storage-fund economics, neither of which change the
`computationCost`/`storageCost` units this report tabulates.

## Approach

**What I built.** `scripts/bench/onchain-gas.ts` — a reusable, reusable-on-any-future-night
end-to-end harness that:

1. Publishes the package to a real local Sui network via `sui client test-publish` (an ephemeral,
   non-`Published.toml` publish — see below for why).
2. Drives the full entry-point lifecycle with real objects: `create_pool`, `propose_withdraw_vk`,
   mints TOKEN via the faucet module, `deposit_and_register`s a real genesis commitment, computes
   the resulting depth-20 Merkle root off-chain (mirroring `circuits/test/transfer.test.mjs`'s
   single-leaf/zero-sibling convention, since `pool.move`'s `commitment_root` starts as 32 zero
   bytes and is only ever updated by an admin/indexer pushing a real root — see
   `contracts/sources/pool.move:395-412`), and pushes it via `update_commitment_root`.
3. Waits for the resulting 1-epoch timelocks (VK update, root update, commitment maturity) to
   elapse for real — `EPOCH_DURATION_MS` is set to 60 000, the minimum `create_pool` allows, and
   the script sleeps past that boundary rather than simulating it.
4. Generates a real Groth16 transfer proof for that genesis commitment (via a `node` subprocess —
   see toolchain note below), submits `shielded_transfer`, then `freeze_pool`/`unfreeze_pool`,
   waits a second epoch for the new commitment to mature, generates a real withdraw proof against
   the change-commitment `shielded_transfer` just created, and submits `zk_withdraw`.
5. Records `effects.gasUsed` (`computationCost`, `storageCost`, `storageRebate`,
   `nonRefundableStorageFee`) for every transaction, straight from the network — nothing computed
   or estimated client-side.

**Why a local network, not the testnet RPC the last two nights were blocked on.** Sui's gas cost
for a given package and inputs is a property of the deterministic Move VM plus a protocol-fixed
storage/computation price schedule — it does not depend on which network executes it. A `sui start
--with-faucet --force-regenesis` local validator, genesis'd on this machine, produces the exact
same `computationCost`/`storageCost` a testnet or mainnet call to the same bytecode with the same
inputs would, modulo the reference gas price (queried live: 1000 MIST/unit on this local network —
`suix_getReferenceGasPrice`). This sidesteps the testnet-RPC block entirely rather than working
around it.

**What I rejected.** Using `@mysten/sui`'s `SuiClient`/gRPC path against testnet again, on the
theory that *this* session's network policy might differ from the last two — rejected without
trying, because the policy denial is explicit and re-testing a denied host wastes a call the "don't
retry policy denials" rule exists to prevent. (I *did* re-verify the policy is still in effect
before deciding to pivot — see Toolchain below — which is not the same as retrying the same call
hoping for a different outcome.) I also considered `sui client call`'s CLI arg syntax instead of the
TypeScript SDK, for a smaller dependency surface — rejected because passing a Groth16 verifying key — 488 bytes as the compressed `vector<u8>`
`create_pool`/`propose_withdraw_vk` actually take (measured: `vkToSuiBytes(transferVk).length ===
488`, `vkToSuiBytes(withdrawVk).length === 424`) — as a few-hundred-element bracketed CLI literal is
both unwieldy and easy to get silently truncated, whereas the SDK's `tx.pure.vector("u8", bytes)` is
exactly what `scripts/src/deploy.ts` and `scripts/src/e2e-test.ts` already use for the same reason.

**Toolchain, from scratch, all real:**

- **`sui` CLI**: not installed, and the direct testnet-RPC path this loop tried on 2026-07-22 is
  still blocked from this sandbox by organization network policy (re-verified once, not retried —
  `curl -X POST https://fullnode.testnet.sui.io:443 ...` → `CONNECT tunnel failed, response 403`).
  Prebuilt Linux binaries *are* reachable, though, via plain `github.com/.../releases/download/...`
  URLs (unlike the `api.github.com` REST API, which this session's GitHub scope blocks, or
  `storage.googleapis.com`, which now returns a real, non-sandbox `AccessDenied` for the
  circuit ptau file — see below). I binary-searched release tags (`testnet-v1.4x.0` through
  `testnet-v1.8x.0`) to find the newest one GitHub actually serves, landing on
  **`testnet-v1.79.0`** (`sui 1.79.0-46f18562f1f5`). An initial guess at `testnet-v1.40.1` also
  downloaded fine but its bundled Move compiler predates syntax the pinned framework git rev
  (`Move.toml`'s `rev = "94ad8ccd..."`) uses (`public(package) fun redeem<T>(..., _:
  internal::Permit<T>)` — an `internal`-module visibility form the older compiler doesn't parse) —
  1.79.0 builds and tests the package cleanly.
- **Local network**: `sui genesis -f --with-faucet && sui start --with-faucet
  --force-regenesis` (a fresh, ephemeral local validator + faucet, both on this machine — no
  external network call at any point after the CLI binary itself was downloaded).
- **`circom`**: same as 2026-07-22 — not installed, built from `iden3/circom` tag `v2.2.2` via
  `cargo install --git https://github.com/iden3/circom.git --tag v2.2.2` (~80s).
- **Powers of Tau (pot15)**: both URLs the existing `compile*.sh` scripts hardcode are now dead
  from this sandbox — `storage.googleapis.com/zkevm/ptau/...` returns a genuine (non-proxy)
  `AccessDenied` from GCS itself ("Anonymous caller does not have storage.objects.get access"),
  and the Hermez S3 mirror returns the same. Rather than lose the night to ptau-hosting archaeology,
  I generated a **fresh local pot15** (`snarkjs powersoftau new bn128 15` → `contribute` → `prepare
  phase2`, entirely offline) — cryptographically equivalent for this purpose: it is the same
  dev-only, single-contributor ceremony class the existing `compile*.sh` scripts already produce
  and document as non-production (`ceremony.sh` is the real multi-party path, unchanged). This is
  a real toolchain gap worth fixing in the actual `compile*.sh` scripts — flagged in Open questions,
  not silently patched over tonight since it's outside this experiment's one hypothesis.
- **Move package management**: the 1.79.0 CLI's newer `sui move` uses a `Published.toml`/environment
  model that `contracts/Move.toml` (pinned to a bare git rev, no `[environments]` table) doesn't
  populate for `localnet`. Plain `sui client publish` refuses with "your package does not define a
  `localnet` environment"; `sui move test` needed an explicit `--build-env testnet` (compile-only —
  it does not connect anywhere) to resolve the same way. For publishing, `sui client test-publish
  --build-env localnet` (an *ephemeral* publish, recorded in a `Pub.localnet.toml` outside
  `Published.toml`) is the documented escape hatch for exactly this case and is what the harness
  uses — it does not touch `contracts/Move.toml` or `Published.toml` at all. It does add an
  additive `[pinned.localnet.*]` dependency-resolution section to `Move.lock` (same shape as the
  existing `[pinned.testnet.*]` section, just for the new environment); that section and
  `Pub.localnet.toml` are both local-toolchain artifacts of *this* run and are not committed — a
  future run regenerates them fresh from the reproduce commands above.
- **snarkjs under Bun**: `snarkjs.groth16.fullProve` spawns `worker_threads` for the
  multi-exponentiation; Bun's `worker_threads`/`EventTarget` shim (the `web-worker` npm package)
  crashes on that path in this environment (`TypeError: Argument 1 ('event') to
  EventTarget.dispatchEvent must be an instance of Event`, inside
  `node_modules/web-worker/cjs/node.js`). Every other real-proving path already in this repo
  (`circuits/test/*.test.mjs`, `scripts/bench/prove-latency.mjs`) already runs under plain Node for
  presumably the same reason. `scripts/bench/prove-helper.mjs` is the same escape hatch for this
  harness: it shells out to `node` for the two `fullProve` + `verify` calls and hands the JSON
  result back to the Bun process, which does the rest (SDK calls, gas recording) natively.

## Results

### Gas per entry point (`effects.gasUsed`, MIST; reference gas price 1000 MIST/unit)

| Entry point | Computation | Storage | Rebate | **Net** (computation + storage − rebate) | Net SUI |
|---|---:|---:|---:|---:|---:|
| `publish` (package + `TreasuryCap`) | 1,380,000 | 156,415,600 | 5,868,720 | **151,926,880** | 0.151927 |
| `create_pool` | 1,000,000 | 8,496,800 | 978,120 | **8,518,680** | 0.008519 |
| `propose_withdraw_vk` | 1,000,000 | 11,726,800 | 8,411,832 | **4,314,968** | 0.004315 |
| `token_faucet::faucet` | 1,000,000 | 4,043,200 | 2,678,544 | **2,364,656** | 0.002365 |
| `deposit_and_register` | 1,000,000 | 13,588,800 | 11,421,432 | **3,167,368** | 0.003167 |
| `update_commitment_root` | 1,000,000 | 11,970,000 | 11,609,532 | **1,360,468** | 0.001360 |
| `shielded_transfer` (real Groth16 proof) | 1,000,000 | 14,242,400 | 12,369,456 | **2,872,944** | 0.002873 |
| `freeze_pool` | 1,000,000 | 11,726,800 | 11,609,532 | **1,117,268** | 0.001117 |
| `unfreeze_pool` | 1,000,000 | 11,726,800 | 11,609,532 | **1,117,268** | 0.001117 |
| `zk_withdraw` (real Groth16 proof) | 1,000,000 | 15,580,000 | 12,128,688 | **4,451,312** | 0.004451 |

Two things fall out immediately that constraint-count intuition would not predict:

1. **Computation is flat at 1,000,000 MIST (1000 gas units, the minimum bucket) for every call
   except `publish`** (1,380,000). The transfer and withdraw circuits differ by 4x in constraint
   count (13,611 vs 3,058) and ~3x in Node proving time (752ms vs 244ms, per `BASELINE.md`), but
   `shielded_transfer` and `zk_withdraw` cost the *same* computation gas — Groth16 verification is
   three pairing checks regardless of circuit size (the constant 128-byte compressed proof from
   `BASELINE.md` is the same fact restated), and Sui's computation-gas bucketing rounds both calls
   into the same minimum bucket. **Circuit complexity does not show up in on-chain gas at all** —
   it only costs proving time, which is paid off-chain by whoever generates the proof.
2. **Storage dominates every number**, and dynamic-field churn dominates storage: `zk_withdraw`
   (removes one `CommitmentKey` dynamic field, adds two — a spent nullifier and a new commitment)
   costs more net than `shielded_transfer` (removes one, adds two as well, but one less nullifier
   byte range) which costs more than `update_commitment_root` (one plain vector field overwrite,
   no dynamic-field object churn). `publish` is two orders of magnitude above everything else
   because it's paying for the whole package's bytecode storage, once.

### Raw command output

```
$ sui --version
sui 1.79.0-46f18562f1f5

$ sui genesis -f --with-faucet
$ sui start --with-faucet --force-regenesis &
$ curl -sS -X POST http://127.0.0.1:9000 -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}'
{"jsonrpc":"2.0","id":1,"result":"b1c2b979"}

$ curl -sS -X POST http://127.0.0.1:9000 -d '{"jsonrpc":"2.0","id":1,"method":"suix_getReferenceGasPrice","params":[]}'
{"jsonrpc":"2.0","id":1,"result":"1000"}

$ cd scripts && bun run bench/onchain-gas.ts
======================================================================
Setup: keypair, funding, Poseidon
======================================================================
  address: 0xd0414dd9251a931c04e10d3976f4f81751bc607fa799ec9e59a265cc89786112

======================================================================
1/10 sui client publish (package + TOKEN TreasuryCap)
======================================================================
  package: 0x933e889fa6d932e48fda25ac25a9092aa654ff435efd8bd8266207f9297a49ce
  [ok] publish: digest=9dc5KXYmpCg1Hwzi5BV7TwHDnbEXaKUXSPbVynfeUmNz computation=1380000 storage=156415600 rebate=5868720 net=151926880 MIST

======================================================================
2/10 pool::create_pool
======================================================================
  [ok] create_pool: digest=8XqimL6SkNtyuuzxLMbDrFYvBvh6Ug22v3z8mmttcZWD computation=1000000 storage=8496800 rebate=978120 net=8518680 MIST
  pool: 0x9c4f635a3d1eece0b84cf1e9c14a3a41b9f9bb7fcb54a8f8f29713c774ba78e9  adminCap: 0x75b360d80026352ebcb6dddf13dd82ce91d05755a07e1736c82f5967b89eae18

======================================================================
3/10 pool::propose_withdraw_vk (admin, 1-epoch timelock)
======================================================================
  [ok] propose_withdraw_vk: digest=ChM7D92XdF6QsiyaLWnQgDvF8zcCtgV8LcqULDGxMAJo computation=1000000 storage=11726800 rebate=8411832 net=4314968 MIST

======================================================================
4/10 token_faucet::faucet (mint TOKEN)
======================================================================
  [ok] token_faucet::faucet: digest=DSDEhVNp4ZSJy2oEJuiqNXQ3boSGHZFFwZaRaxsUQG8s computation=1000000 storage=4043200 rebate=2678544 net=2364656 MIST

======================================================================
5/10 pool::deposit_and_register (genesis commitment)
======================================================================
  [ok] deposit_and_register: digest=62Q2r7nWFXuG1xamnLD5G1Qd7t2ra2XPTuugpk2Pg2tE computation=1000000 storage=13588800 rebate=11421432 net=3167368 MIST

======================================================================
6/10 pool::update_commitment_root (admin, 1-epoch timelock)
======================================================================
  [ok] update_commitment_root: digest=Hxt1AXev28x9663US9Mi2pbxZsL9jvTWxtxiZo726MDN computation=1000000 storage=11970000 rebate=11609532 net=1360468 MIST

======================================================================
Waiting 65000ms for the epoch boundary (VK + root timelock, commitment maturity)
======================================================================

======================================================================
7/10 pool::shielded_transfer (real Groth16 transfer proof)
======================================================================
  generating transfer proof (snarkjs.groth16.fullProve, in a node subprocess)...
  proof: 128B  public inputs: 224B
  [ok] shielded_transfer: digest=BzEamvhg1JhvQGzCCwd8CxU6ztUJLgnzPSbdnvTYvbJZ computation=1000000 storage=14242400 rebate=12369456 net=2872944 MIST

======================================================================
8/10 pool::freeze_pool / unfreeze_pool (admin)
======================================================================
  [ok] freeze_pool: digest=EsCzYHXrCZPJipMCg9HgBp7iRWHM1sAL7aeaEN3RYhjc computation=1000000 storage=11726800 rebate=11609532 net=1117268 MIST
  [ok] unfreeze_pool: digest=8yNaBaEb8aiTL7tFvcsr1mcwAZ2ZDKasUPPZQN1cj1zT computation=1000000 storage=11726800 rebate=11609532 net=1117268 MIST

======================================================================
Waiting 65000ms for the new commitment to mature
======================================================================

======================================================================
9/10 pool::zk_withdraw (real Groth16 withdraw proof)
======================================================================
  generating withdraw proof (snarkjs.groth16.fullProve, in a node subprocess)...
  [ok] zk_withdraw: digest=Hx5TrjmNiWVd3j2RbACz2ZkcUtiqr4diwKH5pEejrTrD computation=1000000 storage=15580000 rebate=12128688 net=4451312 MIST
```

Full JSON (all four `gasUsed` fields per transaction, including `nonRefundableStorageFee`) is
reproducible by re-running the script; it is not checked into the repo since it is regenerable
byte-for-byte from the commands above.

### Test suite (full, per `README.md` — all run for real this time; the Move suite was
`NOT RUN` in the 2026-07-22 baseline for lack of a `sui` CLI)

| Suite | Result | Command |
|---|---|---|
| Move contracts | **124/124 pass** | `cd contracts && sui move test --build-env testnet` |
| `transfer.circom` (real Groth16) | **43/43 pass** | `cd circuits && node --experimental-vm-modules test/transfer.test.mjs` |
| `compliance.circom` (real Groth16) | **30/30 pass** | `cd circuits && node --experimental-vm-modules test/compliance.test.mjs` |
| `withdraw.circom` (real Groth16) | **35/35 pass** | `cd circuits && node --experimental-vm-modules test/withdraw.test.mjs` |
| Proof converter | **109/109 pass** | `cd scripts && bun run src/test-converter.ts` |
| Compliance utils | **67/67 pass** | `cd scripts && bun run src/test-compliance-utils.ts` |
| Frontend (vitest) | **19/19 pass** | `cd frontend && bunx vitest run` |
| Property-based fuzz | **6/6 properties × 500 cases** | `cd scripts && bun run src/fuzz-tests.ts` |

Every number matches `README.md`'s claimed counts exactly. No test was loosened, skipped, or given
new tolerance.

## Verdict: **KEEP**

`docs/research/BASELINE.md`'s last "Not yet measured — BLOCKED" row now has real numbers, from a
real running network, with the exact reproduce commands above. `scripts/bench/onchain-gas.ts` is
reusable for every future night that changes gas cost (batched verification, a different Merkle
depth, a proof-system swap) — diff its output against this baseline rather than re-deriving from
scratch.

## Where this could be used

- **Any Move/Sui protocol doing UTXO-style shielded state via dynamic fields** — the finding that
  storage (specifically dynamic-field churn), not computation, dominates gas is general to that
  pattern on Sui, not specific to Groth16 or to Veil. A protocol considering "verify N proofs in
  one call" should budget for the dynamic-field writes each proof triggers, not just the
  verification cost.
- **A relayer or sponsor economics model** (Veil's own `scripts/src/relayer.ts`, or any sponsored-
  transaction service) — 0.0044 SUI for a withdraw and 0.0029 SUI for a transfer, at this network's
  reference gas price, is the actual per-transaction cost a sponsor is committing to; this table is
  the input a real fee model would start from.
- **A thesis chapter or grant report needing "gas cost is not proportional to circuit size on
  Sui"** as a stated, measured result — the flat 1,000,000-MIST computation cost across two
  circuits with a 4.4x constraint-count gap (13,611 vs 3,058) and a 3.1x proving-time gap (752ms vs
  244ms, `BASELINE.md`) is a clean, citable illustration.

## Open questions (next queue)

1. **`zk_withdraw` never checks `recipient` against the proof's `recipientHash`.**
   `contracts/sources/pool.move:591-623`: the function extracts `commitment_bytes`, `withdraw_amount`,
   and `nullifier` from `public_inputs_bytes` and uses them, but **never extracts bytes `96..128`
   (`recipientHash`) at all** — despite the surrounding comment
   ("`bytes 96-128 (recipientHash) are verified by the proof itself`") asserting that front-running
   is prevented because "changing recipient invalidates the Groth16 proof." That's not what the code
   does: the Groth16 verification call (`verifier::verify_withdraw_proof`) checks that
   `public_inputs_bytes` — a fixed, already-generated blob — is valid for the *proof*, which says
   nothing about the separate `recipient: address` *argument* the transaction also carries. Nothing
   on-chain computes `Poseidon(8, recipient)` and compares it against `recipientHash`. Concretely: a
   valid `(proof_bytes, public_inputs_bytes)` pair for a withdrawal to address A remains valid
   verbatim if resubmitted with `recipient = B` — a front-runner (or a relayer, malicious or merely
   buggy) who observes a pending `zk_withdraw` transaction can copy its `proof_bytes` and
   `public_inputs_bytes` byte-for-byte into their own transaction with their own address as
   `recipient`, and it verifies and pays out to them; the original submitter's nullifier is now
   spent and their real transaction reverts. This is a genuine fund-theft path, not a privacy
   nuance — it deserves an independent look before anything is proposed as a fix (a same-transaction
   check `assert!(Poseidon(8, recipient) == recipientHash)` is the obvious shape, but the recipient
   field element convention needs pinning down first — see below). Added as new top-priority item
   in `EXPERIMENTS.md` and as `docs/threat-model.md` RR10.
2. There is no canonical Sui-address-to-BN254-field-element mapping anywhere in this repo — both
   `circuits/test/withdraw.test.mjs` and this experiment's harness use an arbitrary constant for the
   witness's `recipient` signal (`0xABCDEF123456`) rather than the caller's real address, because
   none exists to reuse. Fixing Open question #1 requires deciding this mapping first (a Sui address
   is 32 bytes / up to 256 bits; BN254's scalar field is ~254 bits, so some canonical reduction is
   needed) — worth resolving as part of, not before, that fix.
3. `circuits/scripts/compile*.sh` all hardcode two now-dead ptau URLs
   (`storage.googleapis.com/zkevm/ptau/...` and, transitively via `ceremony.sh`, its usual mirrors).
   Tonight's harness worked around this by generating a fresh local ptau, which is fine for a
   research/dev run but means a *clean checkout* of this repo cannot actually run `compile.sh` as
   documented anymore. Worth either vendoring a small pot15 (~35MB, arguably too large to commit) or
   updating the scripts to generate one locally by default when no ptau is present, falling back to
   a URL only if provided.
4. Gas under contention: every `shielded_transfer`/`zk_withdraw`/`deposit_and_register` touches the
   same shared `Pool` object. This experiment measured gas for uncontended, sequential calls only —
   what happens to `computationCost` (congestion-priced consensus scheduling) under many concurrent
   callers is a different, scalability-relevant measurement queued but not attempted tonight.
5. `compliant_transfer`'s dual-proof gas cost (transfer proof + compliance/KYC-credential proof,
   verified atomically) was not measured tonight — it needs a `ComplianceConfig` and a seeded
   credential Merkle tree in addition to everything this run already set up, which didn't fit in one
   night alongside the base entry points. Natural follow-up now that the harness and publish/local-
   network path both exist.
