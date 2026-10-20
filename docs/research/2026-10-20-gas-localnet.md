# On-chain gas per entry point, measured on a local Sui network

**Date:** 2026-10-20 · **Queue item:** #1 · **Verdict:** **KEEP** · **Circuit change:** none
**Harness:** [`scripts/bench/gas-localnet.mjs`](../../scripts/bench/gas-localnet.mjs) · **Raw data:** [`2026-10-20-gas-localnet.json`](2026-10-20-gas-localnet.json)

## Hypothesis

Every Veil entry point — including `shielded_transfer`, `zk_withdraw` and `compliant_transfer` with
real Groth16 proofs — can be driven end-to-end on a local Sui network and its `gasUsed` read from
the node's transaction effects, and the Groth16 verification will be a visible, separable share of
`computationCost` (the number the previous baseline had to leave blank, and the one that decides
whether batched/aggregated verification is worth building).

**Result against the hypothesis:** the first half holds; the second half is **falsified**. All 25
transactions report `computationCost` of exactly 1,000,000 MIST (1,370,000 for `publish`) —
including the ones that run `prepare_verifying_key` + `verify_groth16_proof`. Verification is not
separable at this resolution because it sits below the lowest computation bucket. See Results.

## Threat / privacy model

This is a measurement experiment; it changes no circuit, contract or protocol parameter, so it
defends nothing new. What it *does* touch is the cost side of three existing entries in
`docs/threat-model.md`:

- **D2 / D3 (spam, griefing).** An adversary's cost to submit garbage is now a measured number: a
  rejected `shielded_transfer` (tampered proof or nullifier replay) still pays ≈ **1.105–1.107 M MIST
  (0.0011 SUI)**.
- **PRIV-006 / I3 (gas fingerprinting, relayer).** A chain observer sees `gasUsed` of every
  transaction. Because computation is a constant floor across all entry points, the only
  distinguishing gas signal is *storage* (bytes written), which is already implied by the public
  function name and event. No new leakage found; no new leakage created.
- **Relayer budget** (`docs/relayer-api.md`): fixed 0.05 SUI (50,000,000 MIST) per sponsored tx
  versus 2.9–5.0 M MIST measured for the user-facing entry points — a 10–17× over-provision (unspent
  budget is refunded, so this is a liveness margin, not a cost).

**Not defended / residual surface.** The measurement is on a localnet running protocol config of
`sui 1.71.0`; mainnet/testnet may run a different protocol version, reference gas price and storage
price. The deterministic quantities (computation bucket, storage *bytes*) transfer; absolute MIST
for storage and the bucket boundary do not necessarily. Nothing here measures consensus latency or
shared-object contention.

**Assumptions.** Honest local validator; reference gas price 1000 MIST (printed by the harness);
dev-only single-contributor Groth16 setup — gas does not depend on the setup (proof size and
verification work are fixed by the circuit's public-input count). **STRIDE mapping:** D2, D3, I3
(above); no mitigation status changes.

## Approach

`scripts/bench/gas-localnet.mjs` (Node 22) does the following against `sui start --force-regenesis`:

1. `sui client test-publish --build-env local` the real `contracts/` package (the CI pin of the
   Sui framework builds fine with the 1.71.0 binary; the older 1.60.0 binary does not — it cannot
   parse the pinned framework's `internal::Permit`).
2. `create_pool` ×2, mint VEIL through the test faucet, `deposit_and_register`, set the commitment
   Merkle root, propose the withdraw VK, create a `ComplianceConfig`.
3. Wait one 60 s epoch (the contract minimum) so commitments mature and the timelocks elapse.
4. Generate **real proofs** with `snarkjs.groth16.fullProve` at the live on-chain epoch (reusing the
   valid-witness builders from the 2026-07-22 harness, extended to accept `epochId` /
   `currentEpoch` / `transferNullifier` overrides), verify locally, convert with the production
   `proof-converter.ts`, submit.
5. Negative controls on-chain: a valid proof with one public input flipped (aborts `E_INVALID_PROOF`
   = 3) and a nullifier/commitment replay (aborts `E_COMMITMENT_CHAIN_BROKEN` = 9).

**Rejected before building:** (a) public-testnet JSON-RPC reads of historical gas — egress to
`fullnode.testnet.sui.io` is refused by this environment's proxy (`CONNECT` 403), and historical
txs would not isolate entry points anyway; (b) building `sui` from source — unnecessary, release
binaries are downloadable from `github.com/MystenLabs/sui/releases/download/…`; (c) `sui move test
--statistics` as a gas source — it reports `Gas Used ≈ 4.99999950e13` for every test (limit minus
remaining, unrelated to what a transaction is charged), so it is not a usable gas number and was
discarded.

## Results

Units: MIST (1 SUI = 10⁹ MIST). `net = computation + storage − rebate`. Raw JSON is committed. The
whole script was run twice end to end; every `gasUsed` field was identical between runs
(computation and storage are deterministic here).

| Entry point | computation | storage (gross) | rebate | **net** | net (SUI) |
|---|---:|---:|---:|---:|---:|
| `publish` (whole package) | 1,370,000 | 156,415,600 | 978,120 | **156,807,480** | 0.1568 |
| `create_pool` (488 B VK) | 1,000,000 | 8,496,800 | 978,120 | **8,518,680** | 0.0085 |
| `deposit_and_register` | 1,000,000 | 9,021,200 | 8,223,732 | **1,797,468** | 0.0018 |
| `update_commitment_root` | 1,000,000 | 8,740,000 | 8,411,832 | **1,328,168** | 0.0013 |
| `propose_withdraw_vk` (424 B VK) | 1,000,000 | 11,970,000 | 8,652,600 | **4,317,400** | 0.0043 |
| `create_compliance_config` | 1,000,000 | 14,941,600 | 8,652,600 | **7,289,000** | 0.0073 |
| **`shielded_transfer`** (valid) | 1,000,000 | 14,546,400 | 12,670,416 | **2,875,984** | 0.0029 |
| **`zk_withdraw`** (valid) | 1,000,000 | 15,884,000 | 12,429,648 | **4,454,352** | 0.0045 |
| **`compliant_transfer`** (dual proof) | 1,000,000 | 19,326,800 | 15,311,340 | **5,015,460** | 0.0050 |
| `propose_withdrawal` | 1,000,000 | 12,274,000 | 11,850,300 | 1,423,700 | 0.0014 |
| `execute_pending_withdrawal` | 1,000,000 | 13,064,400 | 11,910,492 | 2,153,908 | 0.0022 |
| `propose_vk_update` | 1,000,000 | 15,990,400 | 12,151,260 | 4,839,140 | 0.0048 |
| `cancel_vk_update` | 1,000,000 | 12,274,000 | 15,830,496 | −2,556,496 | −0.0026 |
| `freeze_pool` / `unfreeze_pool` | 1,000,000 | 12,274,000 | 12,151,260 | 1,122,740 | 0.0011 |
| `shielded_transfer`, **tampered input → abort 3** | 1,000,000 | 10,746,400 | 10,638,936 | 1,107,464 | 0.0011 |
| `shielded_transfer` **replay → abort 9** | 1,000,000 | 10,503,200 | 10,398,168 | 1,105,032 | 0.0011 |

Observations, each derived directly from the table above:

1. **Computation is a constant floor.** 1,000,000 MIST = 1,000 computation units × reference gas
   price 1,000. `shielded_transfer` (one Groth16 verify, 7 public inputs), `compliant_transfer` (two
   verifies, 7 + 6 inputs), `zk_withdraw` (one verify, 5 inputs) and `freeze_pool` (two boolean writes) all
   report the same computation cost. Whatever verification costs, it is below one bucket. The
   code comment in `verifier.move` ("~82K gas overhead" for re-preparing the VK on each call) is therefore
   **not billable at the current gas schedule**: eliminating it would not change any number in this table.
2. **The bill is storage.** For `shielded_transfer`, computation is 35 % of net; the rest is storage
   delta (two new dynamic fields: a nullifier, a commitment; one removed: the consumed commitment).
3. **Every transaction that touches `Pool` pays a rewrite tax.** Rebate is exactly 99 % of the prior
   storage charge (12,151,260 / 12,274,000 = 0.99), so rewriting the shared `Pool` object — which
   carries both VKs inline — loses 1 % of its storage cost per touch even when nothing grows. `freeze_pool`,
   which flips two fields, nets 1,122,740 MIST = 1,000,000 + 122,740. This is the floor for any
   state-touching entry point and scales with `Pool` object size.
4. **A rejected proof is not free but is cheap for the attacker:** ≈ 1.105–1.107 M MIST.
   The aborted transactions still consume a shared-object consensus slot on `Pool`.
5. **On-chain VK sizes** are 488 B (transfer), 424 B (withdraw), 456 B (compliance) — not the 4,025 /
   3,656 / 3,841 B in `BASELINE.md`, which are the snarkjs JSON file sizes. Fixed in `BASELINE.md`.

### Raw output (second full run)

```
$ node scripts/bench/gas-localnet.mjs --out docs/research/2026-10-20-gas-localnet.json
[env] {"rpc":"http://127.0.0.1:9000","chain":"31c7e7fc","epochMs":60000,"referenceGasPrice":"1000","sui":"sui 1.71.0-a3cc4467c9de"}
[gas] publish (whole package)                success  comp=1370000 storage=156415600 rebate=978120 net=156807480
[gas] create_pool (transfer VK 488 B)        success  comp=1000000 storage=8496800 rebate=978120 net=8518680
[gas] create_pool (second pool)              success  comp=1000000 storage=8496800 rebate=978120 net=8518680
[gas] faucet (test helper) #1                success  comp=1000000 storage=4043200 rebate=2678544 net=2364656
[gas] deposit_and_register (1st leaf in pool) success  comp=1000000 storage=9021200 rebate=8223732 net=1797468
[gas] deposit_and_register (2nd leaf in pool) success  comp=1000000 storage=9021200 rebate=8223732 net=1797468
[gas] deposit_and_register (compliance pool) success  comp=1000000 storage=9021200 rebate=8223732 net=1797468
[gas] update_commitment_root (pool A)        success  comp=1000000 storage=8740000 rebate=8411832 net=1328168
[gas] propose_withdraw_vk (withdraw VK 424 B) success  comp=1000000 storage=11970000 rebate=8652600 net=4317400
[gas] create_compliance_config               success  comp=1000000 storage=14941600 rebate=8652600 net=7289000
[gas] propose_withdrawal                     success  comp=1000000 storage=12274000 rebate=11850300 net=1423700
[gas] propose_vk_update                      success  comp=1000000 storage=15990400 rebate=12151260 net=4839140
[gas] cancel_vk_update                       success  comp=1000000 storage=12274000 rebate=15830496 net=-2556496
[gas] freeze_pool                            success  comp=1000000 storage=12274000 rebate=12151260 net=1122740
[gas] unfreeze_pool                          success  comp=1000000 storage=12274000 rebate=12151260 net=1122740
[epoch] proving at epoch 29874689
[prove] transfer 2140 ms, 7 public signals
[prove] withdraw 510 ms, 5 public signals
[prove] compliance 1531 ms, 6 public signals
[gas] shielded_transfer, TAMPERED input (abort) failure  comp=1000000 storage=10746400 rebate=10638936 net=1107464
[neg] {"status":"failure", ... function_name: Some("execute_transfer") }, 3) in command 0"}
[gas] shielded_transfer (valid proof)        success  comp=1000000 storage=14546400 rebate=12670416 net=2875984
[gas] shielded_transfer REPLAY (abort)       failure  comp=1000000 storage=10503200 rebate=10398168 net=1105032
[neg] {"status":"failure", ... function_name: Some("execute_transfer") }, 9) in command 0"}
[gas] zk_withdraw (valid proof)              success  comp=1000000 storage=15884000 rebate=12429648 net=4454352
[gas] compliant_transfer (dual proof)        success  comp=1000000 storage=19326800 rebate=15311340 net=5015460
[gas] execute_pending_withdrawal             success  comp=1000000 storage=13064400 rebate=11910492 net=2153908
```

(The prove times printed above are **not** benchmark numbers — a validator was running on the same
machine. Proving latency stays as measured in `BASELINE.md`.)

### Full test suite (before opening the PR)

All green on this branch: `sui move test` **124/124** (sui 1.71.0); circuits `transfer` 43/43,
`withdraw` 35/35, `compliance` 30/30 (run per file — the chained `npm test` hang from queue item 12 is
still present and untouched); `scripts` `test-converter`, `test-compliance-utils`, `fuzz-tests` (6/6
properties); frontend `tsc --noEmit`, `biome check`, `vitest` 19/19.

### Deviations / caveats (stated, not hidden)

- The hosted Powers-of-Tau files (`storage.googleapis.com/zkevm/ptau/...`, Hermez S3) now return
  access-denied, so `pot15` was regenerated locally with `snarkjs powersoftau new/contribute/prepare phase2`.
  Gas is independent of the setup. Constraint counts reproduce exactly (13,611 / 12,743 / 3,058); zkey
  sizes differ by a few bytes from the July run (6,001,422 vs 6,001,431 for transfer), as expected from
  a different contribution. The GCS response was an anonymous-caller permission error, so this is likely not sandbox-specific;
  CI's `curl` of the same URL may fail too — unverified, flagged in Open questions.
- Circuit/ceremony state is dev-only (single contributor), as in `BASELINE.md`.
- Localnet ≠ mainnet: see residual surface above.
- Test-publish used an ephemeral pubfile (`--pubfile-path`) so the repo's `Move.lock` is untouched.

## Verdict

**KEEP.** The previously BLOCKED axis is measured, reproducibly, with real proofs, behind a reusable
script. `BASELINE.md` updated. The decisive discovery is negative for the optimisation story: at the
current gas schedule Groth16 verification is **free** (below the first computation bucket), so
verifier-side micro-optimisations and the *gas* case for proof aggregation are weaker than the queue
assumed; storage footprint and shared-object contention are what remain.

## Where this could be used

- **Any Groth16-on-Sui protocol** (private voting, sealed-bid auctions, ZK-KYC gates, shielded
  stablecoin pools) can use `gas-localnet.mjs` as a template for pre-launch cost sheets: drive the
  real entry points, read `effects.gasUsed`, no testnet needed.
- **Fee-model decisions for a confidential-payroll deployment on Sui** (monthly batch of N salary
  transfers through one pool): per-transfer cost ≈ 0.0029 SUI plus the `Pool` rewrite tax means a
  payroll run is storage-bound — the number to size sponsored-gas pools against.
- **Thesis chapter:** "Cost model of ZK payment pools on object-centric chains" — computation floor vs
  storage-dominated cost is a contrast with EVM chains where `ecPairing` dominates; this table is the
  empirical anchor.

## Open questions (→ queue)

1. **How far below the bucket is Groth16 verification?** Publish a tiny bench module that loops
   `verify_groth16_proof` k times and find the k at which `computationCost` leaves the 1,000-unit
   bucket. That gives verification in real units and decides whether aggregation has any gas case.
2. **Pool object size / contention.** `Pool` carries both VKs inline and every entry point rewrites it
   (1 % tax) *and* serialises on it. Measure concurrent-transfer throughput on localnet with N senders
   and test moving VKs to dynamic fields / a read-only config object.
3. **CI breakage risk:** the `circuit-tests` job downloads `pot15` from a URL that returned
   AccessDenied from this environment (unverified from GitHub runners). Needs a new mirror or a cached artifact before the next PR touching circuits.
4. Re-measure on testnet (storage price and bucket table may differ) once egress to a public fullnode
   is permitted.
