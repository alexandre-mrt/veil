# 2026-10-15 — On-chain gas per Veil entry point (queue item #1)

## Hypothesis

Veil's on-chain cost per entry point (`create_pool`, `deposit_and_register`, `shielded_transfer`,
`zk_withdraw`, timelocked admin ops) can be measured with **real Groth16 proofs** on a local Sui
network, and the marginal computation cost of one Groth16 verification is **below the 1,000-unit
minimum computation bucket**, i.e. today's per-transfer computation cost is a floor charge that
proof verification does not move. The numbers this moves from "unmeasured" to "measured":
computation + storage + rebate (MIST) for 8 entry points, and units-per-verification /
units-per-VK-preparation for `sui::groth16` (BN254).

## Threat / privacy model

No protocol change — no circuit, Move module or frontend code was modified. The relevant adversary
is an **economic one**: a spammer or griefer who wants to make pool operation expensive or
exhaust a user's gas, and a designer who must know what an operation really costs before trading
anything against it (batching, caching, compliance dual-proof).

- A chain observer learns nothing new: every figure below is public in transaction effects.
- Gas is **not** a privacy surface here, but note one thing it exposes: `shielded_transfer` and
  `zk_withdraw` have *different, fixed* gas profiles (net 2.87M vs 4.45M MIST), so gas alone
  distinguishes transfer from withdraw — already distinguishable by entry point, so no new leak.
- Not defended / not established: costs on mainnet. This ran on a **localnet** with the
  protocol config of CLI 1.72.1 (reference gas price 1000 MIST/unit). Computation *units* are
  protocol-defined and portable; **storage prices and the reference gas price are not** — treat the
  MIST figures as relative, re-measure on testnet before quoting dollars.
- Assumptions: unchanged (Groth16/BN254, dev-only trusted setup — RR2 in
  `docs/threat-model.md`; a locally generated pot15 ptau was used, see below; it does not affect
  gas because proof/VK size and public-input count are circuit-defined).
- STRIDE mapping: Denial of Service (cost to attacker per rejected/accepted tx). Failed-replay
  cost recorded below is the relevant griefing number.

## Approach

1. **Toolchain unblocked** (the blocker from the 2026-07-22 run): a prebuilt `sui` binary is
   downloadable from GitHub releases through the sandbox proxy. The `contracts/Move.toml`
   framework rev (`94ad8ccd…`) is Sui **1.72.1**; the first binary tried (1.50.1) cannot compile it
   (`internal::Permit` unknown), `testnet-v1.72.1` can. `circom` 2.2.2 likewise from the release
   asset. The Hermez ptau host (storage.googleapis.com) is denied, so a pot15 ptau was generated
   locally with snarkjs (`powersoftau new/contribute/prepare phase2`, 7m38s) — dev-only, same
   trust class as the existing single-contributor setup.
2. **`scripts/bench/gas-localnet.ts`** — publishes the real package to a local network, creates a
   pool (60 s epochs, the contract minimum), registers commitments, waits for epoch maturity and
   timelocks, then submits a **real** transfer proof (13,611-constraint circuit, 7 public inputs)
   and a real withdraw proof (5 public inputs), plus a replay as a negative control. Proofs are
   produced by `scripts/bench/prove-for-gas.mjs` under Node (snarkjs' worker threads exit silently
   under bun). `witnesses.mjs` gained an optional `{epochId}` so the proof matches the pool epoch.
3. **`scripts/bench/gas-verify-scaling.ts`** + `scripts/bench/verify-bench/` — because Sui bills
   computation in buckets (floor 1,000 units), a single call cannot reveal the cost of a
   verification. A bench-only Move package calls the same `sui::groth16` natives as
   `veil::verifier` N times in one tx; the slope of computation cost vs N is the marginal cost.
   `verify_n(prepare_each=true)` mirrors `veil::verifier` exactly; `false` prepares the VK once.

**Rejected alternatives:** `sui move test --statistics` (reports Move-VM gas without the
protocol's bucketing/storage, and the Move tests contain no valid proofs — they only exercise
rejection paths); JSON-RPC history reads of the deployed testnet package (fullnode host is
denied by the proxy: `403` on CONNECT); modifying `veil::verifier` to expose a public verify
(would change the audited contract for a measurement).

## Results

Reproduce (≈1 min for the gas run after build; localnet must be up):

```
sui start --force-regenesis --with-faucet &          # sui 1.72.1
cd circuits && bash scripts/compile.sh && bash scripts/compile-withdraw.sh
cd ../scripts && bun run bench/gas-localnet.ts --out gas.json
cd ../scripts && bun run bench/gas-verify-scaling.ts
```

### Gas per entry point (MIST; RGP = 1000 MIST/unit; 1 SUI = 10^9 MIST)

| Entry point | Computation | Storage | Rebate | Net | Notes |
|---|---|---|---|---|---|
| publish (package + token init) | 1,390,000 | 156,415,600 | 9,781,200 | 148,024,400 | 17,046 bytes of modules |
| `create_pool` | 1,000,000 | 8,496,800 | 978,120 | 8,518,680 | 488-byte transfer VK |
| `deposit_and_register` (×4, identical) | 1,000,000 | 9,021,200 | 8,223,732 | **1,797,468** | |
| `update_commitment_root` (propose) | 1,000,000 | 8,740,000 | 8,411,832 | 1,328,168 | timelocked |
| `propose_withdraw_vk` | 1,000,000 | 11,970,000 | 8,652,600 | 4,317,400 | 424-byte VK |
| `freeze_pool` / `unfreeze_pool` | 1,000,000 | 11,970,000 | 11,850,300 | 1,119,700 | each |
| **`shielded_transfer`** (real proof) | 1,000,000 | 14,242,400 | 12,369,456 | **2,872,944** | 128 B proof, 224 B inputs |
| **`zk_withdraw`** (real proof) | 1,000,000 | 15,580,000 | 12,128,688 | **4,451,312** | 128 B proof, 160 B inputs |
| `shielded_transfer` replay (rejected, `E_COMMITMENT_CHAIN_BROKEN`=9) | 1,000,000 | 10,199,200 | 10,097,208 | 1,101,992 | attacker still pays |

Every Veil entry point sits at the **minimum computation bucket (1,000,000 MIST = 1,000 units)**;
the net cost is dominated by storage (state growth) in every case.

### Marginal cost of Groth16 verification (`sui::groth16`, BN254, real 7-input transfer proof)

| Calls in one tx | verify only (VK prepared once) | prepare + verify each (as `veil::verifier`) | prepare only |
|---|---|---|---|
| 1 | 1,000 units (floor) | 1,000 (floor) | 1,000 (floor) |
| 10 | 1,930 | 2,760 | 1,000 (floor) |
| 50 | 9,240 | 13,400 | 4,160 |
| 100 | 18,400 | 26,700 | 8,310 |
| 200 | 36,700 | — | — |

Slopes from the large-N points: **verify ≈ 183 units**, **prepare ≈ 83 units**,
**prepare+verify ≈ 266 units** per proof (`(26,700−13,400)/50`). One `shielded_transfer`
verification therefore consumes **~27% of the 1,000-unit floor**; a second proof in the same
transaction (e.g. a compliance proof) would still fit under it (~532 units, extrapolated — **not
measured** as a combined call). The 83-unit prepare figure agrees with the "~82K gas" note in
`contracts/sources/verifier.move`.

### Raw output

`docs/research/2026-10-15-onchain-gas-per-entry-point.raw.json` holds every row with digests.
Console output of the two runs:

```
publish (package + token init)     success  comp=1390000 stor=156415600 rebate=9781200 net=148024400
create_pool                        success  comp=1000000 stor=8496800 rebate=978120 net=8518680
deposit_and_register #1 (first leaf) success  comp=1000000 stor=9021200 rebate=8223732 net=1797468
deposit_and_register #2            success  comp=1000000 stor=9021200 rebate=8223732 net=1797468
deposit_and_register #3            success  comp=1000000 stor=9021200 rebate=8223732 net=1797468
deposit_and_register #4            success  comp=1000000 stor=9021200 rebate=8223732 net=1797468
update_commitment_root (propose)   success  comp=1000000 stor=8740000 rebate=8411832 net=1328168
propose_withdraw_vk                success  comp=1000000 stor=11970000 rebate=8652600 net=4317400
freeze_pool                        success  comp=1000000 stor=11970000 rebate=11850300 net=1119700
unfreeze_pool                      success  comp=1000000 stor=11970000 rebate=11850300 net=1119700
shielded_transfer (real proof, 7 pub) success  comp=1000000 stor=14242400 rebate=12369456 net=2872944
zk_withdraw (real proof, 5 pub)    success  comp=1000000 stor=15580000 rebate=12128688 net=4451312
shielded_transfer REPLAY (must fail) failure  comp=1000000 stor=10199200 rebate=10097208 net=1101992
    {"status":"failure","error":"MoveAbort(... function_name: Some("execute_transfer")) }, 9) in command 0"}
reference gas price: 1000 MIST/unit
```
```
verify x1 (prepare once)             success  computationCost=1000000 MIST = 1000 units
verify x5 (prepare once)             success  computationCost=1020000 MIST = 1020 units
verify x10 (prepare once)            success  computationCost=1930000 MIST = 1930 units
verify x25 (prepare once)            success  computationCost=4670000 MIST = 4670 units
verify x50 (prepare once)            success  computationCost=9240000 MIST = 9240 units
verify x100 (prepare once)           success  computationCost=18400000 MIST = 18400 units
verify x200 (prepare once)           success  computationCost=36700000 MIST = 36700 units
verify x1 (prepare each, as veil::verifier) success  computationCost=1000000 MIST = 1000 units
verify x5 (prepare each, as veil::verifier) success  computationCost=1430000 MIST = 1430 units
verify x10 (prepare each, as veil::verifier) success  computationCost=2760000 MIST = 2760 units
verify x25 (prepare each, as veil::verifier) success  computationCost=6740000 MIST = 6740 units
verify x50 (prepare each, as veil::verifier) success  computationCost=13400000 MIST = 13400 units
verify x100 (prepare each, as veil::verifier) success  computationCost=26700000 MIST = 26700 units
prepare_verifying_key only x1        success  computationCost=1000000 MIST = 1000 units
prepare_verifying_key only x10       success  computationCost=1000000 MIST = 1000 units
prepare_verifying_key only x50       success  computationCost=4160000 MIST = 4160 units
prepare_verifying_key only x100      success  computationCost=8310000 MIST = 8310 units
```

### Test suite (CLAUDE.md does not exist in the repo; ran each package's own suite)

- `sui move test` (Sui 1.72.1): `Test result: OK. Total tests: 124; passed: 124; failed: 0` —
  this also closes the "Move tests NOT RUN" row in BASELINE.
- `cd circuits && npm test` (all three files, real proofs): transfer, compliance, withdraw all
  exit 0 (chained with `&&`); withdraw ended `Results: 35 passed, 0 failed`. (The `ERROR: Error in
  template Withdraw_149` lines are expected assertion failures from the negative tests.)
- `cd scripts && bun run test`: `Results: 109 passed, 0 failed`.

### Limits of this measurement

- One run, one machine, localnet. Computation cost is deterministic (bucketed), storage cost is
  deterministic given object sizes; there is no run-to-run variance to report beyond the four
  identical `deposit_and_register` rows. Mainnet/testnet storage price and RGP differ — relative
  ordering and unit counts transfer, MIST amounts do not.
- Storage cost was **not decomposed** (which dynamic field / which byte range costs what).
- The compliance entry points (`compliance.move`) were not exercised — that needs the compliance
  circuit and a config object; not done tonight.
- `zk_withdraw` net cost includes the recipient receiving a new coin object (storage for it).
- Circuits were built with a locally generated ptau, not the Hermez one; verification cost does
  not depend on it.

## Verdict

**KEEP.** On-chain gas is measured for the first time (BASELINE.md updated), the toolchain
blocker is cleared and documented, and the measurement yields a falsifiable, negative-for-
optimization result: **verification is not where Veil pays.** Computation is pinned to the floor
bucket for every entry point; ≥ 89% of each transaction's gross cost is storage.

Consequence for the queue (re-ranked in `EXPERIMENTS.md`): batched/aggregated proof verification
(N→1) is demoted — at ~266 units per transfer it saves nothing until >3 verifications share a
transaction, and nullifiers/commitments must still be stored per transfer. Caching the
`PreparedVerifyingKey` (the `verifier.move` TODO) would save ~83 units per call, **which is
invisible under the floor**.

## Where this could be used

- **Thesis chapter on cost of privacy on object-model chains:** a per-operation cost table where
  proof verification is below the billing floor and state growth (nullifier set, commitment set)
  is the real price — a result specific to Sui's bucketed computation + storage-fund model that
  doesn't hold on EVM chains, where pairing precompiles dominate.
- **Other Groth16-on-Sui protocols** (private voting with per-ballot nullifiers, confidential
  payroll on Sui with a t-of-n auditor board, anonymous-credential gating): the 183-unit verify /
  83-unit prepare figures let them budget how many proofs fit in one PTB under the 1,000-unit floor
  (≈3 prepare+verify, ≈5 verify-only).
- **Rollup-style aggregators on Sui:** the verify-scaling harness is the break-even test for
  whether proof aggregation pays — here it doesn't until verification exceeds the floor.

## Open questions (→ tomorrow's queue)

1. Decompose storage: nullifier `NullifierKey→bool` vs commitment `CommitmentKey→u64` dynamic fields
   vs Pool/gas-coin mutation — what is the per-transfer *permanent* state cost (storage minus
   rebate) and can nullifier storage be made cheaper (e.g. sharded bitmaps)?
2. Compliance path: gas of `compliance.move` transfer-with-proof (dual proof, one tx) — does it stay
   under the floor? Needs the compliance circuit build and config setup.
3. Re-measure on testnet (RPC denied from this sandbox) to get real storage price / RGP, and
   shared-object contention under concurrent transfers on the single `Pool` object.
4. Does Move-side Merkle-root recomputation or an on-chain tree change the picture (the pool
   stores only a root set by timelocked admin update — one `update_commitment_root` is 1.33M MIST net)?
