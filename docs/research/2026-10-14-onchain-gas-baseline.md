# 2026-10-14 — On-chain gas per entry point (queue item #1)

## Hypothesis

The per-entry-point gas of Veil's Move contracts, and in particular the cost of the Groth16
verification path (the `verifier.move` comment claims "~82K gas" saved by caching the
`PreparedVerifyingKey`), can be **measured** from transactions executed on a local Sui network —
moving "on-chain gas per entry point" in `BASELINE.md` from BLOCKED to a table of measured values,
and confirming or refuting the 82K figure.

Falsifiable outcome: if measured `prepare_verifying_key` cost is not within ±25 % of 82 000 (read
as MIST at the reference gas price of 1000, i.e. ~82 units), the comment is wrong.

## Threat / privacy model

This is a measurement night; no circuit or contract was changed. The adversary models that the
numbers inform:

- **Griefing / DoS attacker** spamming invalid proofs: what does an aborted `shielded_transfer`
  cost them? (Measured: ≈1.10 M MIST, i.e. barely more than the 1000-unit computation floor — see
  Results.) The attacker pays; the pool is not mutated by an abort.
- **Chain observer / statistical deanonymiser**: gas is *not* a side channel here — success-path
  gas is identical across runs for the same entry point, and the storage delta depends only on
  object sizes, not on amounts or identities. (Only one witness was run per entry point; this is
  an observation on this data, not a proof of constant-time.)

Not defended / out of scope: everything about proof-system soundness, the dev-only trusted setup
(`threat-model.md` RR2), shared-object contention on the `Pool` under concurrent transfers (not
measured — queue), and mainnet gas prices (all numbers are at localnet RGP = 1000 MIST/unit;
computation *units* transfer to other networks, MIST totals scale with the live RGP).
Assumptions: the local validator's gas schedule at protocol version of CLI 1.72.1 matches the
network the pool is deployed to (`Move.toml` pins framework rev `94ad8cc`, tag 1.72.1).

**An incidental security finding was made while building the harness** (below) — it maps to STRIDE
entry **E7** in `docs/threat-model.md`, which this PR changes from *Mitigated* to *OPEN*.

## Approach

Built, all reusable and committed:

- `scripts/bench/gas-bench.mjs` — publishes the real `contracts/` package to a local network and
  drives every flow of the transfer/withdraw lifecycle with **real Groth16 proofs** from the
  compiled circuits: `create_pool`, `deposit_and_register`, `update_commitment_root`,
  `propose_withdraw_vk` (both timelocks wait one 60 s epoch — the pool's minimum), then
  `shielded_transfer` and `zk_withdraw`. Success paths are executed; abort paths are dry-run.
- `scripts/bench/gas-probe.mjs` + `scripts/bench/gas-probe/` (a tiny Move package) — Sui bills
  computation in a coarse way: any transaction costing < 1000 units is charged exactly 1000 units
  (the "floor"). A single verification is below that, so it is invisible in a single transaction.
  The probe repeats `prepare_verifying_key` / `verify_groth16_proof` *n* times in one transaction
  and dry-runs it for n = 1…512, then reads the slope. Above the floor the charge is linear in n
  (10-unit granularity).

Rejected alternatives: (1) JSON-RPC reads of historical testnet gas — outbound requests to Sui
fullnodes are blocked by the sandbox proxy (HTTP 403 on CONNECT); (2) `sui move test --statistics`
— reports Move-VM test-mode "gas used" in unrelated units (≈5·10¹³ − small), not protocol gas;
(3) estimating from the framework's cost tables — would be an estimate, not a measurement.

Toolchain notes (these cost real time, recorded so the next run does not repeat them):
the latest `sui` CLI (1.60.0, first download) **cannot compile** the pinned framework rev
(`error[E03006] Could not resolve the name 'internal'`); the CLI must match the pinned rev →
**1.72.1** from `github.com/MystenLabs/sui/releases` (`testnet-v1.72.1`, ~1 GB; the proxy truncates
long transfers — resume with `curl -C -`). `storage.googleapis.com` and the Hermez S3 bucket are
403, so the Powers-of-Tau file was **generated locally** (`snarkjs powersoftau new bn128 15` →
contribute → `prepare phase2`, ~8 min) — functionally equivalent for gas (proof validity, sizes)
but, like the existing dev ceremony, **not** a trusted setup. `circom` v2.2.2 was built from
source. `sui move build` needs `--no-tree-shaking` offline.

## Results

### Entry-point gas (localnet, RGP = 1000 MIST/unit, sui 1.72.1)

Computation is shown in **units** (computationCost / 1000). Storage cost, rebate and net are MIST.
Net = computation + storage − rebate.

| Entry point | Computation (units) | Storage cost | Storage rebate | **Net (MIST)** | Net (SUI) |
|---|---|---|---|---|---|
| publish (6 modules) | 1380 | 156 415 600 | 4 890 600 | **152 905 000** | 0.1529 |
| `create_pool` (488 B VK) | 1000 | 8 496 800 | 978 120 | **8 518 680** | 0.0085 |
| `deposit_and_register` (pool empty) | 1000 | 9 021 200 | 8 223 732 | **1 797 468** | 0.0018 |
| `deposit_and_register` (pool has 1 commitment) | 1000 | 9 021 200 | 8 223 732 | **1 797 468** | 0.0018 |
| `update_commitment_root` (propose) | 1000 | 8 740 000 | 8 411 832 | **1 328 168** | 0.0013 |
| `propose_withdraw_vk` (424 B VK) | 1000 | 11 970 000 | 8 652 600 | **4 317 400** | 0.0043 |
| **`shielded_transfer`** (success) | 1000 | 14 242 400 | 12 369 456 | **2 872 944** | 0.0029 |
| **`zk_withdraw`** (success) | 1000 | 15 580 000 | 12 128 688 | **4 451 312** | 0.0045 |
| `shielded_transfer`, aborted (threshold mismatch, before verify) | 1000 | 10 442 400 | 10 337 976 | 1 104 424 | 0.0011 |
| `shielded_transfer`, aborted (bad proof, after verify) | 1000 | 10 442 400 | 10 337 976 | 1 104 424 | 0.0011 |
| `shielded_transfer` replay (rejected) | 1000 | 10 199 200 | 10 097 208 | 1 101 992 | 0.0011 |
| `zk_withdraw`, aborted (bad proof) | 1000 | 10 199 200 | 10 097 208 | 1 101 992 | 0.0011 |

Findings from the table:

1. **Every entry point except `publish` bills exactly the 1000-unit computation floor.** For a
   single transfer the Groth16 verification (below) is *entirely hidden* under the floor — gas cannot
   distinguish an aborted-before-verify transaction from an aborted-after-verify one (identical rows).
2. **Cost is dominated by storage, not computation**: for `shielded_transfer`, 1.0 M of the 2.87 M MIST
   net is the computation floor; the remaining ~1.87 M is net storage churn (two new dynamic fields —
   nullifier, new commitment — minus the rebate for the removed old commitment and the Pool rewrite).
3. `deposit_and_register` gas does **not** grow with pool size between 0 and 1 existing commitments
   (dynamic-field insert is O(1) in gas). Larger pools were not measured.
4. A rejected / aborted proof costs the sender ≈1.10 M MIST (0.0011 SUI) — about 10 % above the
   computation floor, and ~38 % of a successful transfer's net cost. A verification-spam attacker
   therefore pays almost as much per attempt as an honest user, but the abort does not mutate pool
   state; there is no cost amplification in the attacker's favour.
5. Dry-run and executed `shielded_transfer` rows are identical (2 872 944 net), as expected.

### Verification cost, resolved by repetition (`gas-probe.mjs`)

Per-iteration computation in gas units (1 unit = 1000 MIST at RGP 1000), slope of the linear
region (n = 128→256 gives the same value within 0.5 %):

| Circuit (public inputs) | `prepare_verifying_key` | `verify_groth16_proof` (PVK prepared) | prepare + verify (**what Veil does per call**) |
|---|---|---|---|
| withdraw (5) | 83.5 | 164.3 | **247.0** |
| compliance (6) | 83.4 | 173.8 | **257.2** |
| transfer (7) | 83.4 | 183.4 | **266.6** |

- **The "~82K gas" comment in `verifier.move` is confirmed**: measured 83.4 units ≈ 83 400 MIST at
  RGP 1000 (the comment's "K gas" reads as MIST). Hypothesis not falsified.
- Verification scales ≈ 9.5 units per public input over a ~116-unit pairing base (164.3 / 173.8 / 183.4).
- **But the optimisation is worth 0 MIST today**: a full transfer verification is 267 units, below the
  1000-unit floor, so caching the PVK would not change what any single-transfer transaction pays.
  It only becomes material when one transaction contains enough verifications to leave the floor:
  floor-crossing at ≈4 full verifications (≈5–6 with a cached PVK) in one PTB. The empty loop stays
  under the floor through n = 4096, so interpreter overhead is negligible (< 0.25 unit/iter).

### Move test suite

`sui move test` with the matching 1.72.1 CLI: **124 passed, 0 failed** (`Test result: OK. Total tests: 124; passed: 124; failed: 0`).

Rest of the suite, run before opening the PR (no test was modified): `npm test` in `circuits/` —
43 + 30 + 35 passed, 0 failed; `bun run test` in `scripts/` (proof-converter) — 109 passed, 0 failed.

### Finding — `zk_withdraw` does not bind the recipient (E7 is not mitigated)

`gas-bench.mjs` ends with a side probe: it deposits a commitment, generates a valid withdraw proof
whose `recipientHash = Poseidon(8, 0x1111111111)`, and submits `zk_withdraw` with an **unrelated
address** as the `recipient` argument. Result:

```
[gas] zk_withdraw with ATTACKER recipient (proof bound to other recipient) comp=1000000 stor=15580000 rebate=12128688 net=4451312  success
[probe] tx status = success; attacker-address token coins = 1 (balance 100)
```

Root cause: `pool.move` `zk_withdraw` verifies the Groth16 proof (which commits to
`recipientHash` as public input bytes 96..128) but never recomputes `Poseidon(8, recipient)` or
compares it with those bytes; the comment at `pool.move:595-599` ("changing recipient invalidates
the Groth16 proof") is incorrect because `recipient` is not an input to the verifier. Impact: the user's signed transaction cannot be altered in flight (the sender signature covers the
recipient argument), but the *proof bytes and public inputs* are copyable: any party that sees them
before the user's transaction executes — an RPC/fullnode provider, a validator, a relayer or sponsor
(`scripts/src/relayer.ts` receives the full transaction kind), or anyone the user sent the proof to —
can submit a new transaction of their own with the same proof and their own address as `recipient`.
The first one executed consumes the commitment and nullifier, so the honest withdrawal then fails.
Sui has no public mempool, which narrows the observer set but does not remove it, and it is precisely
the observer the circuit's `recipientHash` constraint was written to defeat. The frontend does not
currently call `zk_withdraw` (grep of `frontend/src` and `scripts/src`), so the exposure is the
contract entry point itself. Not fixed in this
PR: the fix needs an address→field mapping agreed between the frontend prover and Move (Sui addresses
are 256 bits, the BN254 scalar field is ~254) and either `sui::poseidon::poseidon_bn254` over
`address mod r` or a circuit change. Queued as the top item for the next run; `threat-model.md` E7
now reads OPEN.

### Raw output

`node scripts/bench/gas-bench.mjs --sui <sui-1.72.1> --json out.json` (full log:
`data/2026-10-14/gas-bench.txt`, structured: `gas-bench.json`):

```
sui CLI: sui 1.72.1-94ad8ccd0ed6
reference gas price: 1000 MIST/unit  (computation units = computationCost / 1000)
[gas] publish (6 modules)                                  comp=1380000 stor=156415600 rebate=4890600 net=152905000  success
transfer VK: 488 B, withdraw VK: 424 B
[gas] create_pool (transfer VK 488 B)                      comp=1000000 stor=8496800 rebate=978120 net=8518680  success
[gas] token_faucet::faucet (mint 1000 VEIL)                comp=1000000 stor=4043200 rebate=2678544 net=2364656  success
[gas] deposit_and_register #1 (pool has 0 commitments)     comp=1000000 stor=9021200 rebate=8223732 net=1797468  success
[gas] token_faucet::faucet #2                              comp=1000000 stor=4043200 rebate=2678544 net=2364656  success
[gas] deposit_and_register #2 (pool has 1 commitments)     comp=1000000 stor=9021200 rebate=8223732 net=1797468  success
[gas] update_commitment_root (propose, 32 B)               comp=1000000 stor=8740000 rebate=8411832 net=1328168  success
[gas] propose_withdraw_vk (424 B)                          comp=1000000 stor=11970000 rebate=8652600 net=4317400  success
waiting for epoch > 29866054 (epoch = 60s) so the timelocks and commitment maturity elapse...
[gas] shielded_transfer abort: threshold mismatch (pre-verify) comp=1000000 stor=10442400 rebate=10337976 net=1104424  failure (MoveAbort(MoveLocation { module: ModuleId { address: b37c985)
[gas] shielded_transfer abort: bad proof (post-verify)     comp=1000000 stor=10442400 rebate=10337976 net=1104424  failure (MoveAbort(MoveLocation { module: ModuleId { address: b37c985)
[gas] shielded_transfer SUCCESS (dry-run)                  comp=1000000 stor=14242400 rebate=12369456 net=2872944  success
[gas] shielded_transfer SUCCESS                            comp=1000000 stor=14242400 rebate=12369456 net=2872944  success
[gas] shielded_transfer replay (rejected)                  comp=1000000 stor=10199200 rebate=10097208 net=1101992  failure (MoveAbort(MoveLocation { module: ModuleId { address: b37c985)
[gas] zk_withdraw abort: bad proof (post-verify)           comp=1000000 stor=10199200 rebate=10097208 net=1101992  failure (MoveAbort(MoveLocation { module: ModuleId { address: b37c985)
[gas] zk_withdraw SUCCESS                                  comp=1000000 stor=15580000 rebate=12128688 net=4451312  success
[gas] token_faucet::faucet #4 (probe)                      comp=1000000 stor=4043200 rebate=2678544 net=2364656  success
[gas] deposit_and_register (probe commitment)              comp=1000000 stor=12251200 rebate=11421432 net=1829768  success
[gas] zk_withdraw with ATTACKER recipient (proof bound to other recipient) comp=1000000 stor=15580000 rebate=12128688 net=4451312  success
[probe] tx status = success; attacker-address token coins = 1 (balance 100)
```

`node scripts/bench/gas-probe.mjs --sui <sui-1.72.1> --circuit transfer|withdraw|compliance`
(full logs: `data/2026-10-14/gas-probe-*.txt`):

```
sui CLI: sui 1.72.1-94ad8ccd0ed6
transfer circuit: vk 488 B, proof 128 B, public inputs 224 B (7 signals)
loop_noop: scan [[1,1000],[2,1000],[4,1000],[8,1000],[16,1000],[32,1000],[64,1000],[128,1000],[256,1000],[512,1000],[1024,1000],[2048,1000],[4096,1000]]
  transitions []
  fit null
loop_prepare: scan [[1,1000],[2,1000],[4,1000],[8,1000],[16,1350],[32,2680],[64,5330],[128,10700],[256,21400],[512,42800]]
  transitions [{"n":12,"prevBucketUnits":1000},{"n":17,"prevBucketUnits":1350},{"n":33,"prevBucketUnits":2680},{"n":65,"prevBucketUnits":5330},{"n":129,"prevBucketUnits":10700},{"n":257,"prevBucketUnits":21400}]
  fit {"slopeUnitsPerIter":83.44516606656123,"interceptUnits":-57.89503202431782}
loop_verify_prepared: scan [[1,1000],[2,1000],[4,1000],[8,1570],[16,3040],[32,5960],[64,11900],[128,23600],[256,47100],[512,94100]]
  transitions [{"n":5,"prevBucketUnits":1000},{"n":9,"prevBucketUnits":1570},{"n":17,"prevBucketUnits":3040},{"n":33,"prevBucketUnits":5960},{"n":65,"prevBucketUnits":11900},{"n":129,"prevBucketUnits":23600},{"n":257,"prevBucketUn
  fit {"slopeUnitsPerIter":183.3680649832564,"interceptUnits":-37.793352339578895}
loop_verify_full: scan [[1,1000],[2,1000],[4,1090],[8,2150],[16,4280],[32,8530],[64,17100],[128,34200],[256,68400]]
  transitions [{"n":4,"prevBucketUnits":1000},{"n":5,"prevBucketUnits":1090},{"n":9,"prevBucketUnits":2150},{"n":17,"prevBucketUnits":4280},{"n":33,"prevBucketUnits":8530},{"n":65,"prevBucketUnits":17100},{"n":129,"prevBucketUnits
  fit {"slopeUnitsPerIter":266.575104074251,"interceptUnits":-213.23960963625203}
=== per-iteration computation (gas units; 1 unit = reference-gas-price MIST) ===
loop_noop              n/a units/iter
loop_prepare           83.4 units/iter
loop_verify_prepared   183.4 units/iter
loop_verify_full       266.6 units/iter
```
```
sui CLI: sui 1.72.1-94ad8ccd0ed6
withdraw circuit: vk 424 B, proof 128 B, public inputs 160 B (5 signals)
loop_noop: scan [[1,1000],[2,1000],[4,1000],[8,1000],[16,1000],[32,1000],[64,1000],[128,1000],[256,1000],[512,1000],[1024,1000],[2048,1000],[4096,1000]]
  transitions []
  fit null
loop_prepare: scan [[1,1000],[2,1000],[4,1000],[8,1000],[16,1350],[32,2670],[64,5320],[128,10700],[256,21400],[512,42800]]
  transitions [{"n":12,"prevBucketUnits":1000},{"n":17,"prevBucketUnits":1350},{"n":33,"prevBucketUnits":2670},{"n":65,"prevBucketUnits":5320},{"n":129,"prevBucketUnits":10700},{"n":257,"prevBucketUnits":21400}]
  fit {"slopeUnitsPerIter":83.46154277574004,"interceptUnits":-62.628573992439975}
loop_verify_prepared: scan [[1,1000],[2,1000],[4,1000],[8,1420],[16,2730],[32,5350],[64,10600],[128,21100],[256,42200],[512,84300]]
  transitions [{"n":6,"prevBucketUnits":1000},{"n":9,"prevBucketUnits":1420},{"n":17,"prevBucketUnits":2730},{"n":33,"prevBucketUnits":5350},{"n":65,"prevBucketUnits":10600},{"n":129,"prevBucketUnits":21100},{"n":257,"prevBucketUn
  fit {"slopeUnitsPerIter":164.30396977998603,"interceptUnits":-54.406915210399475}
loop_verify_full: scan [[1,1000],[2,1000],[4,1010],[8,2000],[16,3970],[32,7920],[64,15900],[128,31700],[256,63500]]
  transitions [{"n":4,"prevBucketUnits":1000},{"n":5,"prevBucketUnits":1010},{"n":9,"prevBucketUnits":2000},{"n":17,"prevBucketUnits":3970},{"n":33,"prevBucketUnits":7920},{"n":65,"prevBucketUnits":15900},{"n":129,"prevBucketUnits
  fit {"slopeUnitsPerIter":246.97900316203734,"interceptUnits":-172.64268977911186}
=== per-iteration computation (gas units; 1 unit = reference-gas-price MIST) ===
loop_noop              n/a units/iter
loop_prepare           83.5 units/iter
loop_verify_prepared   164.3 units/iter
loop_verify_full       247.0 units/iter
```
```
sui CLI: sui 1.72.1-94ad8ccd0ed6
compliance circuit: vk 456 B, proof 128 B, public inputs 192 B (6 signals)
loop_noop: scan [[1,1000],[2,1000],[4,1000],[8,1000],[16,1000],[32,1000],[64,1000],[128,1000],[256,1000],[512,1000],[1024,1000],[2048,1000],[4096,1000]]
  transitions []
  fit null
loop_prepare: scan [[1,1000],[2,1000],[4,1000],[8,1000],[16,1350],[32,2680],[64,5330],[128,10700],[256,21400],[512,42800]]
  transitions [{"n":12,"prevBucketUnits":1000},{"n":17,"prevBucketUnits":1350},{"n":33,"prevBucketUnits":2680},{"n":65,"prevBucketUnits":5330},{"n":129,"prevBucketUnits":10700},{"n":257,"prevBucketUnits":21400}]
  fit {"slopeUnitsPerIter":83.44516606656123,"interceptUnits":-57.89503202431782}
loop_verify_prepared: scan [[1,1000],[2,1000],[4,1000],[8,1490],[16,2880],[32,5660],[64,11300],[128,22400],[256,44600],[512,89200]]
  transitions [{"n":6,"prevBucketUnits":1000},{"n":9,"prevBucketUnits":1490},{"n":17,"prevBucketUnits":2880},{"n":33,"prevBucketUnits":5660},{"n":65,"prevBucketUnits":11300},{"n":129,"prevBucketUnits":22400},{"n":257,"prevBucketUn
  fit {"slopeUnitsPerIter":173.83277464876608,"interceptUnits":-52.530245537613936}
loop_verify_full: scan [[1,1000],[2,1000],[4,1050],[8,2070],[16,4120],[32,8230],[64,16500],[128,33000],[256,65900]]
  transitions [{"n":4,"prevBucketUnits":1000},{"n":5,"prevBucketUnits":1050},{"n":9,"prevBucketUnits":2070},{"n":17,"prevBucketUnits":4120},{"n":33,"prevBucketUnits":8230},{"n":65,"prevBucketUnits":16500},{"n":129,"prevBucketUnits
  fit {"slopeUnitsPerIter":257.159284788098,"interceptUnits":-200.81894492595373}
=== per-iteration computation (gas units; 1 unit = reference-gas-price MIST) ===
loop_noop              n/a units/iter
loop_prepare           83.4 units/iter
loop_verify_prepared   173.8 units/iter
loop_verify_full       257.2 units/iter
```

## Verdict

**KEEP.** On-chain gas is now measured for every transfer/withdraw lifecycle entry point and for the
verification primitive; `BASELINE.md` is updated. Not measured and still open: `compliant_transfer`,
`create_compliance_config`, the other admin/timelock calls (freeze, VK/threshold updates, multisig),
deposits into a large pool, and a PTB with k transfers (the empirical floor-crossing point). A
critical finding (E7) was discovered and is documented, not fixed.

## Where this could be used

- **Any Sui ZK protocol using `sui::groth16`** (private voting, confidential payroll with a
  t-of-n auditor board, shielded stablecoin rails): the actionable fact is the *1000-unit floor* —
  a Groth16 verification costs 164–267 units, so ≈4 verifications per PTB are free up to the floor.
  Proof batching by PTB composition (not recursion) already captures most of the available gas
  saving on Sui today. Thesis chapter: "Cost model of on-chain SNARK verification on Sui".
- The bisection-on-n technique for resolving costs below a billing floor applies to measuring any
  Move primitive (hashing, `poseidon_bn254`, BLS) — directly reusable for the Poseidon2 experiment
  (queue #3) to price an on-chain commitment recomputation.
- The recipient-binding gap is a pattern worth a checklist item for any protocol that binds a ZK
  proof to a Sui address: the verifier call alone does not bind account-level arguments.

## Open questions (→ queue)

1. Fix E7 (top priority): bind `recipient` to proof; measure the extra gas of `poseidon_bn254` on
   `address mod r`; add a Move negative test and a localnet regression in `gas-bench.mjs`.
2. Real PTB with k = 1..8 `shielded_transfer` calls (needs k valid proofs): where does the bill
   leave the floor, and does the Pool shared-object lock serialize them?
3. Gas of `compliant_transfer` end-to-end (compliance proof + transfer proof in one tx — expected
   ≥ 2 verifications ≈ 520 units) and `create_compliance_config`.
4. Storage-dominated cost: can the ~1.9 M MIST net storage of a transfer be reduced (e.g. one
   dynamic field instead of two, or bundled nullifier set)?
5. Does a larger pool (10³–10⁵ commitments) change deposit/transfer gas? Expected flat; unmeasured.
6. Aborted transactions show a storage charge ≈ rebate on the shared Pool (net ≈ 1.1 M MIST). Why
   the Pool is re-stored on abort was not investigated.
