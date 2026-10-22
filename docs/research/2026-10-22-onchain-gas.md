# 2026-10-22 — On-chain gas per entry point (queue item #1)

## Hypothesis

Every Veil entry point's real on-chain gas (computation, storage, rebate) can be measured with
**real Groth16 proofs** on a local Sui network, and the Groth16 verification — believed to be the
dominant on-chain cost — is **not** what a user pays for today. Falsifiable form: if verification
dominates, `compliant_transfer` (two verifications) should cost visibly more computation than
`zk_withdraw` (one verification of a 5x smaller circuit's VK) and than a plain `deposit_and_register`
(none). This closes the last "BLOCKED" row in `BASELINE.md`.

## Threat / privacy model

Measurement night: no protocol, circuit or Move change, so no privacy property changes. The
adversary this *informs* is the **griefing / spam adversary** (STRIDE "Denial of service" in
`docs/threat-model.md`): what does it cost to hammer the shared `Pool` object with junk? Measured
answer below: an aborted replay costs the attacker 1,101,992 MIST net, 1,000,000 of it computation floor.

Does NOT establish: mainnet prices (localnet reference gas price is 1000 MIST/unit, the storage price
is the protocol constant of Sui 1.72.2 — mainnet's reference gas price and any later storage-price
change scale the numbers), shared-object contention under concurrent load (single sender here), or
anything about the relayer.

Assumptions: Sui 1.72.2 gas schedule (the CLI matching the framework rev in `contracts/Move.lock`);
Groth16/BN254 soundness unchanged; the dev-only trusted setup used to produce the proofs is not
production-safe (RR2) — irrelevant to gas.

## Approach

Built, all reusable:

- `scripts/bench/gas-localnet.mjs` — publishes the real `contracts/` package to a fresh localnet, then
  runs every proof-bearing entry point with real proofs (`create_pool`, `deposit_and_register`,
  `update_commitment_root`, `propose_withdraw_vk`, `create_compliance_config`, `freeze/unfreeze`,
  `shielded_transfer`, `zk_withdraw`, `compliant_transfer`, and a replay that must abort). Epoch length
  is the pool minimum (60 s); timelocks and commitment maturity are waited out, not bypassed.
- `scripts/bench/gas-verify-sweep.mjs` + `scripts/bench/move-gas/` — a throwaway Move package that runs
  `prepare_verifying_key` + `verify_groth16_proof` N times in one transaction. Needed because the first
  script showed every entry point sitting on Sui's 1000-unit computation floor, which hides the
  cost of one verification; sweeping N reads it off the slope instead.
- `scripts/bench/witnesses.mjs` gained optional `epochId` / `currentEpoch` / `expiryEpoch` overrides
  (defaults unchanged, so the earlier proving benchmarks are unaffected).

Rejected before building: JSON-RPC reads against the deployed testnet (the sandbox blocks the public
fullnode: `CONNECT tunnel failed, response 403`), and building the Sui workspace from source (the
prebuilt release `mainnet-v1.72.2` from github.com/MystenLabs/sui releases downloaded fine).

## Results

Gas per entry point (MIST; 1 SUI = 1e9 MIST; net = computation + storage − rebate; localnet RGP 1000):

| Entry point | computation | computation units | storage | rebate | **net** |
|---|---|---|---|---|---|
| publish (package) | 1,390,000 | 1,390 | 156,415,600 | 9,781,200 | 148,024,400 |
| create_pool | 1,000,000 | 1,000 | 8,496,800 | 978,120 | 8,518,680 |
| deposit_and_register (1000 denom) | 1,000,000 | 1,000 | 9,021,200 | 8,223,732 | 1,797,468 |
| deposit_and_register (100 denom) | 1,000,000 | 1,000 | 10,358,800 | 8,223,732 | 3,135,068 |
| update_commitment_root (propose) | 1,000,000 | 1,000 | 8,740,000 | 8,411,832 | 1,328,168 |
| propose_withdraw_vk | 1,000,000 | 1,000 | 11,970,000 | 8,652,600 | 4,317,400 |
| create_compliance_config | 1,000,000 | 1,000 | 14,941,600 | 8,652,600 | 7,289,000 |
| freeze_pool / unfreeze_pool | 1,000,000 | 1,000 | 8,983,200 | 8,893,368 | 1,089,832 |
| **shielded_transfer** (1 proof) | 1,000,000 | 1,000 | 14,242,400 | 12,369,456 | **2,872,944** |
| **zk_withdraw** (1 proof) | 1,000,000 | 1,000 | 15,580,000 | 12,128,688 | **4,451,312** |
| **compliant_transfer** (2 proofs) | 1,000,000 | 1,000 | 19,326,800 | 15,311,340 | **5,015,460** |
| shielded_transfer replay (aborts) | 1,000,000 | 1,000 | 10,199,200 | 10,097,208 | 1,101,992 |

The hypothesis is **falsified**: `compliant_transfer` computation equals `deposit_and_register` computation.
Everything sits on Sui's 1,000-unit computation floor. The sweep resolves what the floor hides
(computation units per transaction; linear fit from N=64→256):

| Per-iteration cost | units | = MIST at RGP 1000 |
|---|---|---|
| prepare_verifying_key + verify (what `verifier.move` does per call) | 267.2 | 267,200 |
| prepare_verifying_key alone | 83.6 | 83,600 |
| verify with an already-prepared VK | 183.6 | 183,600 |

So one verification is ~267 units; the floor swallows the first ~3.7 of them
(N=3 → 1000, N=4 → 1090). `compliant_transfer` (2 verifications ≈ 534 units + Move/dynamic-field work) stays
under the floor. The comment in `verifier.move` ("storing a PreparedVerifyingKey saves ~82K gas per
verification") is **confirmed in magnitude** (measured 83.6K MIST ≈ 83.6 units) but is worth **0 MIST today**
for every entry point, because the floor absorbs it.

Where the money goes: for `shielded_transfer`, net 2,872,944 MIST = 1,000,000 computation floor (35%) +
1,872,944 net storage (65%; two dynamic fields added — nullifier, new commitment — one removed — old
commitment — plus the Pool object's rewrite). I did not separate those components; that is a follow-up.

Reproduce: `sui start --force-regenesis --with-faucet &` then
`node scripts/bench/gas-localnet.mjs --out gas.json` and `node scripts/bench/gas-verify-sweep.mjs --out sweep.json`
(circuits must be built per `scripts/bench/prove-latency.mjs`'s header). Raw JSON in `docs/research/data/2026-10-22-*.json`.

Environment: `sui 1.72.2-85b460a63fd7` (prebuilt `mainnet-v1.72.2`), circom 2.2.2 built from source, snarkjs 0.7.6, Node v22.22.0.
Caveat: the Hermez `pot15` ptau was unreachable (HTTP 403 from storage.googleapis.com), so a local single-contribution
`powersoftau new bn128 15` ceremony was used; constraint counts re-measured identical to `BASELINE.md`
(13,611 / 3,058 / 12,743 total, i.e. 6470+7141, 1465+1593, 6057+6686). Gas does not depend on ptau randomness.
Gas is deterministic for a given input; each number is one run (the sweep's two slope windows agree to <0.5% for
full/prepare, ~0.4% for prepared).

Raw output, `gas-localnet.mjs` (stdout of the single run above):

```
publish (package)                  computation=1390000 storage=156415600 rebate=9781200 net=148024400
create_pool (A)                    computation=1000000 storage=8496800 rebate=978120 net=8518680
deposit_and_register               computation=1000000 storage=9021200 rebate=8223732 net=1797468
deposit_and_register (100-unit denom) computation=1000000 storage=10358800 rebate=8223732 net=3135068
update_commitment_root (propose)   computation=1000000 storage=8740000 rebate=8411832 net=1328168
propose_withdraw_vk                computation=1000000 storage=11970000 rebate=8652600 net=4317400
create_compliance_config           computation=1000000 storage=14941600 rebate=8652600 net=7289000
freeze_pool                        computation=1000000 storage=8983200 rebate=8893368 net=1089832
unfreeze_pool                      computation=1000000 storage=8983200 rebate=8893368 net=1089832
shielded_transfer                  computation=1000000 storage=14242400 rebate=12369456 net=2872944
zk_withdraw                        computation=1000000 storage=15580000 rebate=12128688 net=4451312
compliant_transfer (2 proofs)      computation=1000000 storage=19326800 rebate=15311340 net=5015460
shielded_transfer REPLAY (aborts)  computation=1000000 storage=10199200 rebate=10097208 net=1101992
```

Raw output, `gas-verify-sweep.mjs`:

```
full_n      N=  0 ok=true computationUnits=1000
full_n      N=  1 ok=true computationUnits=1000
full_n      N=  2 ok=true computationUnits=1000
full_n      N=  3 ok=true computationUnits=1000
full_n      N=  4 ok=true computationUnits=1090
full_n      N=  6 ok=true computationUnits=1620
full_n      N=  8 ok=true computationUnits=2150
full_n      N= 12 ok=true computationUnits=3210
full_n      N= 16 ok=true computationUnits=4280
full_n      N= 24 ok=true computationUnits=6400
full_n      N= 32 ok=true computationUnits=8530
full_n      N= 48 ok=true computationUnits=12800
full_n      N= 64 ok=true computationUnits=17100
full_n      N= 96 ok=true computationUnits=25600
full_n      N=128 ok=true computationUnits=34200
full_n      N=192 ok=true computationUnits=51300
full_n      N=256 ok=true computationUnits=68400
prepare_n   N=  0 ok=true computationUnits=1000
prepare_n   N=  1 ok=true computationUnits=1000
prepare_n   N=  2 ok=true computationUnits=1000
prepare_n   N=  3 ok=true computationUnits=1000
prepare_n   N=  4 ok=true computationUnits=1000
prepare_n   N=  6 ok=true computationUnits=1000
prepare_n   N=  8 ok=true computationUnits=1000
prepare_n   N= 12 ok=true computationUnits=1020
prepare_n   N= 16 ok=true computationUnits=1350
prepare_n   N= 24 ok=true computationUnits=2010
prepare_n   N= 32 ok=true computationUnits=2670
prepare_n   N= 48 ok=true computationUnits=4000
prepare_n   N= 64 ok=true computationUnits=5330
prepare_n   N= 96 ok=true computationUnits=7980
prepare_n   N=128 ok=true computationUnits=10700
prepare_n   N=192 ok=true computationUnits=16000
prepare_n   N=256 ok=true computationUnits=21400
prepared_n  N=  0 ok=true computationUnits=1000
prepared_n  N=  1 ok=true computationUnits=1000
prepared_n  N=  2 ok=true computationUnits=1000
prepared_n  N=  3 ok=true computationUnits=1000
prepared_n  N=  4 ok=true computationUnits=1000
prepared_n  N=  6 ok=true computationUnits=1200
prepared_n  N=  8 ok=true computationUnits=1570
prepared_n  N= 12 ok=true computationUnits=2300
prepared_n  N= 16 ok=true computationUnits=3030
prepared_n  N= 24 ok=true computationUnits=4500
prepared_n  N= 32 ok=true computationUnits=5960
prepared_n  N= 48 ok=true computationUnits=8890
prepared_n  N= 64 ok=true computationUnits=11900
prepared_n  N= 96 ok=true computationUnits=17700
prepared_n  N=128 ok=true computationUnits=23600
prepared_n  N=192 ok=true computationUnits=35300
prepared_n  N=256 ok=true computationUnits=47100
```

Test suites, run on this branch before the PR: `sui move test` → `Test result: OK. Total tests: 124; passed: 124; failed: 0`;
circuits `transfer` 43/43, `withdraw` 35/35, `compliance` 30/30 (run per file); `scripts` `bun run src/test-converter.ts` → 109 passed, 0 failed.
Frontend `vitest` was **not run** (no `node_modules`, no frontend change tonight).

## Verdict

**KEEP.** The measurement is merged-worthy and `BASELINE.md` is updated. Findings that change the queue:

1. Verification is not the on-chain bottleneck at current load; **storage is** (≈65% of a transfer's net cost).
2. Batching/aggregating proofs (old queue #3) and storing a `PreparedVerifyingKey` save **0 MIST** until a single
   transaction does ≥4 full verifications. Demoted.
3. A failed/replayed transfer still costs the sender ~1.1M MIST — the spam floor.

## Where this could be used

- Any Sui protocol that verifies Groth16 on-chain (private payments, zk-login-style identity gates, rollup bridges):
  the `gas-verify-sweep` method is a general way to read the true cost of a `sui::groth16` call that the 1000-unit
  floor hides; and the finding that ~3.7 verifications are free per transaction bounds how much a batching design can save.
- A confidential payroll batch on Sui (pay N employees in one PTB): up to 3 verified transfers per transaction cost
  the same computation as one; beyond that, cost scales at ~267 units each — sizing input for the thesis chapter on
  on-chain cost models of shielded pools.

## Open questions (→ queue)

- Decompose `shielded_transfer`'s 1.87M net storage per dynamic field; can the nullifier set use a cheaper layout
  (e.g. one object per bucket/Bloom-style prefix, or `Table` vs raw dynamic fields)?
- At what PTB size does computation actually leave the floor, and does a PTB of 3 shielded transfers stay at 1000 units?
- Does the floor/price picture hold on testnet/mainnet (different reference gas price)? Needs network access this sandbox lacks.
- Shared-object contention on `Pool` under concurrent senders (not measured here).
