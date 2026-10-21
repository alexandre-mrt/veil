# 2026-10-21 — On-chain gas per entry point (queue item #1)

## Hypothesis

Every proof-verifying and state-mutating Veil entry point can be executed end-to-end with real
Groth16 proofs on a real Sui execution environment and its gas measured per transaction — closing
the one axis `BASELINE.md` marked BLOCKED — and the measurement will show whether Groth16
verification (paid once per `shielded_transfer`, twice per `compliant_transfer`) is a meaningful
share of gas. That second half is the falsifiable part: **if verification dominates, batched /
aggregated verification (queue #3) is the next lever; if it does not, it is not.**

Measurement night: no circuit, Move or frontend protocol code changed.

## Threat / privacy model

No protocol change, so no adversary model changes. What the numbers matter for:

- **Griefing / DoS economics** (`docs/threat-model.md`, Denial of Service): the cost to an attacker
  of spamming `shielded_transfer` with proofs that fail late, and the cost to a legitimate user of
  a transfer, were previously unknowable. This gives the first real inputs.
- **Anonymity-set economics** (RR5): every deposit/transfer permanently adds dynamic fields to the
  shared `Pool`; the per-operation *net storage* below is the price of growing the set.

Not established here: mainnet/testnet prices (this is a localnet — see Caveats), behaviour under
concurrent load on the shared `Pool` object (not measured), or anything about relayer fees.
Assumptions unchanged: Groth16/BN254 soundness, dev-only single-contributor setup (RR2) — the
keys used here are such a dev setup and say nothing about production keys.

## Approach

`scripts/bench/gas.ts` (new, reusable) does the whole thing against `sui start --force-regenesis`:

1. publishes the real `contracts/` package (offline build, `--no-tree-shaking`),
2. `create_pool` with the real transfer VK, 60 s epochs (the contract minimum),
3. proposes the commitment root (real depth-20 Poseidon tree containing two genesis commitments)
   and the withdraw VK, creates the `ComplianceConfig` with the real compliance VK,
4. 3 × `deposit_and_register`, waits one epoch for the timelocks / commitment maturity,
5. generates real proofs with snarkjs from the real compiled circuits and submits
   `shielded_transfer`, `compliant_transfer` (transfer proof + compliance proof, context-bound via
   `transferNullifier`) and `zk_withdraw`. Every transaction must succeed or the script aborts.

Gas is read from `effects.gasUsed`. Alternatives rejected: (a) public-testnet RPC history — the
sandbox's egress policy returns 403 for every Sui fullnode (not retried, per policy); (b)
`sui move test --statistics` — measures Move VM instructions, not Sui's metered gas, and the
unit-test harness cannot produce a true `gasUsed`.

**Unblocking the toolchain** (the queue asked to spend the start of the run on this): the `sui`
CLI *is* obtainable — GitHub release assets download through the proxy even though
`api.github.com` does not. The Move framework pinned in `contracts/Move.toml`
(`94ad8ccd…`, 2026-05-12) needs a compiler from the v1.72 line; v1.60.0 fails with
`Could not resolve the name 'internal'`. `sui 1.72.2` (mainnet-v1.72.2 asset) works.

## Results

Environment: `sui 1.72.2-85b460a63fd7`, localnet, reference gas price 1000 MIST/unit, circom 2.2.2,
snarkjs 0.7.6, bun runtime. Circuits recompiled from this commit: 13,611 / 12,743 / 3,058
constraints (identical to the 2026-07-22 baseline).

| Entry point | Computation (MIST) | Storage cost (MIST) | Storage rebate (MIST) | **Net (MIST)** | Net (SUI) |
|---|---|---|---|---|---|
| `deposit_and_register` (×3, identical) | 1,000,000 | 14,075,200 | 11,902,968 | **3,172,232** | 0.0032 |
| `shielded_transfer` (1 Groth16 verify) | 1,000,000 | 14,485,600 | 12,610,224 | **2,875,376** | 0.0029 |
| `compliant_transfer` (2 Groth16 verifies) | 1,000,000 | 22,800,000 | 18,509,040 | **5,290,960** | 0.0053 |
| `zk_withdraw` (1 Groth16 verify) | 1,000,000 | 15,823,200 | 12,369,456 | **4,453,744** | 0.0045 |
| `create_pool` | 1,000,000 | 8,496,800 | 978,120 | 8,518,680 | 0.0085 |
| `propose_withdraw_vk` | 1,000,000 | 11,970,000 | 8,652,600 | 4,317,400 | 0.0043 |
| `propose commitment root` (`update_commitment_root`) | 1,000,000 | 8,740,000 | 8,411,832 | 1,328,168 | 0.0013 |
| `create_compliance_config` | 1,000,000 | 18,414,800 | 11,850,300 | 7,564,500 | 0.0076 |
| package publish (one-off) | 1,380,000 | 156,415,600 | 4,890,600 | 152,905,000 | 0.1529 |
| `token_faucet::faucet` (testnet only) | 1,000,000 | 4,043,200 | 2,678,544 | 2,364,656 | 0.0024 |

**Finding 1 — Groth16 verification is invisible in computation gas.** Every transaction, including
`compliant_transfer` with *two* pairing-based verifications and the `faucet` mint with none,
pays exactly `1,000,000` MIST computation = 1,000 gas units × 1,000 MIST: the minimum bucket.
(Only `publish` exceeds it, at 1,380,000.) The verify cost is below the resolution of Sui's gas
bucketing at this protocol version, so *per-transaction verification cost is not what Veil pays
for* — storage is. This does **not** say verification is free in validator CPU terms, only that
it is not priced at this granularity.

**Finding 2 — cost is storage, and it is permanent state.** For the user-facing entry points computation is
19–35% of net cost (`shielded_transfer`: 1.0 M of 2.88 M MIST, 35%; `deposit`: 32%;
`zk_withdraw`: 22%; `compliant_transfer`: 19%). `compliant_transfer` costs 1.84× a plain
transfer in net MIST while its computation charge is identical, so the whole difference is
storage; my hypothesis is the extra credential-nullifier dynamic field plus the `ComplianceConfig`
rewrite, but I did not isolate it (open question 2). Every transfer leaves a permanent
nullifier + new-commitment dynamic field on the shared `Pool`.

**Finding 3 (tooling debt, not gas) — the repo's `ptau` download URL is dead.**
`circuits/scripts/compile*.sh`, `ceremony.sh`, `.github/workflows/ci.yml:59` and
`scripts/bench/prove-latency.mjs` all fetch
`https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau`; today that returns
`403 AccessDenied` (the output below). The CI job that compiles circuits therefore cannot
succeed as written. Worked around here with the PSE perpetual-powers-of-tau `2^15` file +
`snarkjs powersoftau prepare phase2` (works; ~8 min on this machine). Not fixed in this PR — it
touches CI and I cannot run CI from here. Top of the queue.

Determinism: across three invocations of `gas.ts` the gas rows were identical (two earlier attempts
died before the proof-verifying calls because of bugs in the script itself — `bun` exiting
silently on snarkjs worker threads, fixed with `singleThread`, and a test credential whose expiry
was below the current epoch — but the setup/deposit rows that did complete in those attempts
matched the final run exactly).

### Raw output

```
$ bun run scripts/bench/gas.ts --sui <sui-1.72.2>
sui: sui 1.72.2-85b460a63fd7
reference gas price: 1000 MIST/unit

publish (one-off)                  success  comp=1380000 storage=156415600 rebate=4890600 net=152905000
create_pool                        success  comp=1000000 storage=8496800 rebate=978120 net=8518680
token_faucet::faucet (testnet only) success  comp=1000000 storage=4043200 rebate=2678544 net=2364656
propose commitment root            success  comp=1000000 storage=8740000 rebate=8411832 net=1328168
propose_withdraw_vk                success  comp=1000000 storage=11970000 rebate=8652600 net=4317400
create_compliance_config           success  comp=1000000 storage=18414800 rebate=11850300 net=7564500
deposit_and_register (A)           success  comp=1000000 storage=14075200 rebate=11902968 net=3172232
deposit_and_register (B)           success  comp=1000000 storage=14075200 rebate=11902968 net=3172232
deposit_and_register (W)           success  comp=1000000 storage=14075200 rebate=11902968 net=3172232

waiting 18 s for epoch 29876123 ...

shielded_transfer                  success  comp=1000000 storage=14485600 rebate=12610224 net=2875376
compliant_transfer (2 proofs)      success  comp=1000000 storage=22800000 rebate=18509040 net=5290960
zk_withdraw                        success  comp=1000000 storage=15823200 rebate=12369456 net=4453744
```

(`scripts/bench/gas-results.json` is the machine-readable copy of the same run.)

```
$ curl -sS -o /dev/null -w '%{http_code}\n' https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau
403   # body: AccessDenied ... storage.objects.get denied on bucket zkevm

$ sui move test          # contracts/, sui 1.72.2
Test result: OK. Total tests: 124; passed: 124; failed: 0
```

Other suites, run on this branch with the artifacts above: `circuits` `npm test` — 43 + 30 + 35
passed, 0 failed (transfer, compliance, withdraw); `scripts` `bun run test` — 109 passed, 0 failed.
Frontend tests not run (no frontend change).

### Caveats (read before citing a number)

- **Localnet, not testnet/mainnet.** Storage price per byte is a protocol constant and carries
  over; computation is `units × reference gas price`, and the *unit count* (the minimum bucket)
  carries over while the MIST figure scales with the live price.
- **Single sample per entry point** (deposits ×3). Gas is deterministic for identical state, and
  three runs matched, but storage figures depend on `Pool` object size at call time (it grows as
  VKs are installed), so numbers drift by small amounts with pool configuration.
- Pre-bucketing gas units are not exposed; "below the minimum bucket" is an inference from
  identical charges, not a measured unit count.
- Different ptau than the 2026-07-22 baseline ⇒ zkeys differ by ~9 bytes; irrelevant to gas.

## Verdict

**KEEP.** `BASELINE.md` now has an on-chain gas table; `scripts/bench/gas.ts` reproduces it. The
experiment also *changes the queue*: verification is not the priced cost, so **queue #3 (batched
verification) is demoted** — it would save ≈0 computation gas — and storage footprint per
transfer becomes the number to attack.

## Where this could be used

- **Fee modelling for a Veil relayer / sponsored-transaction service on Sui**: the net-MIST column
  is the floor a relayer must price into a transfer, independent of proof size.
- **Any Groth16-on-Sui protocol** (zk-login-style credential checks, private voting, confidential
  payroll with a t-of-n auditor board): Finding 1 says an on-chain `groth16` verify is priced in
  the minimum compute bucket on current Sui, so cost modelling should focus on object/dynamic-field
  writes, not pairing count. That is the sentence a thesis chapter on "ZK on object-centric
  chains" can cite (with this run as the evidence).
- **Anonymity-set cost**: net storage per deposit (0.0032 SUI) × set size is the direct cost of
  the 10^5–10^7 commitment regime in queue #4.

## Open questions (→ queue)

1. Fix the dead `ptau` URL in CI + compile scripts (verified workaround: PSE `ppot_0080_15.ptau` +
   `powersoftau prepare phase2`).
2. What fraction of per-transfer storage is the `Pool` rewrite vs the new dynamic fields? (Would
   a sharded / per-epoch nullifier object, or storing only a hash-set root, shrink it?)
3. Shared-object contention: how many `shielded_transfer`/s does one `Pool` sustain? (Every tx
   mutates the same shared object.)
4. Re-run on testnet if egress policy ever allows, to confirm the minimum-bucket claim at live
   protocol config.
