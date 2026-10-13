# 2026-10-13 — On-chain gas per entry point (queue item #1)

## Hypothesis

Real on-chain gas for every Veil entry point (publish, `create_pool`, `deposit_and_register`,
`shielded_transfer`, `zk_withdraw`, `compliant_transfer`, and the timelocked admin proposals) can be
measured with genuine Groth16 proofs verified by `sui::groth16`, and the per-verification share of
`computationCost` can be bracketed well enough to say whether the two optimisations already on the
roadmap — storing a `PreparedVerifyingKey` (comment in `verifier.move` claims "~82K gas") and
batching N proofs into one verification (queue #3) — would move the bill. Number moved: "gas
entry points with measured cost" from 0 to 11, plus a measured per-verify computation cost.

## Threat / privacy model

A measurement night; no protocol change. Relevant adversaries:

- **Economic / griefing adversary** — wants to make transfers too expensive or exhaust the pool's
  shared-object throughput. Needs real cost numbers to reason about; this supplies them.
- **Malicious or colluding relayer / mempool observer** — surfaced *incidentally*, see
  "Incidental security finding" below (this is the real find of the night).

What this does **not** establish: mainnet prices (localnet has reference gas price 1000 MIST and
Sui's default storage price; mainnet RGP differs, so computation MIST scale but *units* do not),
shared-object contention under concurrency (single sender, sequential txs), or anything about
privacy. Assumptions: the local network runs the same `sui::groth16` natives and protocol config as
the 1.81.1 release (`sui 1.81.1-e04cf9aa915c`); the dev-only Groth16 setup is used (verify cost is
independent of the ceremony). STRIDE mapping: E7 (see finding) is the only entry touched.

## Approach

- Unblocked the toolchain (the blocker from 2026-07-22): the prebuilt `sui 1.81.1` release tarball
  *is* downloadable from `github.com/MystenLabs/sui/releases`; public fullnode RPC is denied by the
  sandbox's egress policy (not retried), so measurement runs on a **local network** (`sui start
  --force-regenesis --with-faucet`), which executes real transactions through the real execution
  layer and reports real gas. circom 2.2.2 rebuilt from source; all three circuits recompiled.
- `scripts/bench/gas-localnet.ts`: publishes the package and drives the full protocol with real
  proofs, including the three timelocks (60 s epochs = pool minimum) and commitment maturity.
  Two transfers share one 2-leaf depth-20 tree so a single `update_commitment_root` serves both.
- `scripts/bench/gas-probe.ts` + `scripts/bench/gas-probe/` (bench-only Move package): n repeated
  verifications in one tx. Sui bills computation as `max(1000 units, used)` so a single entry point
  cannot show its true compute; sweeping n recovers the marginal per-verify cost.
- Rejected: testnet RPC replay (egress denied); `sui move test --statistics` (does not report the
  billed gas model, would not be real transactions); building Sui from source (hours).
- Deviation: the Hermez `pot15` download (`storage.googleapis.com/zkevm`) returned 403, so a local
  dev `pot15_final.ptau` was generated with `snarkjs powersoftau new/contribute/prepare phase2`.
  Constraint counts are unaffected (identical to BASELINE); verification cost is independent of the
  ptau. Proving-time numbers from 2026-07-22 are not re-measured here.

## Results

### Entry-point gas (localnet, RGP = 1000 MIST/unit, n = 1 per row except deposit n = 3)

| Entry point | computation (MIST) | storage (MIST) | rebate (MIST) | **net (MIST)** | net (SUI) |
|---|---|---|---|---|---|
| `publish` | 1,380,000 | 156,415,600 | 4,890,600 | **152,905,000** | 0.152905 |
| `create_pool` | 1,000,000 | 8,496,800 | 978,120 | **8,518,680** | 0.008519 |
| `deposit_and_register #1` | 1,000,000 | 9,021,200 | 8,223,732 | **1,797,468** | 0.001797 |
| `deposit_and_register #2` | 1,000,000 | 9,021,200 | 8,223,732 | **1,797,468** | 0.001797 |
| `deposit_and_register #3` | 1,000,000 | 9,021,200 | 8,223,732 | **1,797,468** | 0.001797 |
| `update_commitment_root (propose)` | 1,000,000 | 8,740,000 | 8,411,832 | **1,328,168** | 0.001328 |
| `propose_withdraw_vk` | 1,000,000 | 11,970,000 | 8,652,600 | **4,317,400** | 0.004317 |
| `create_compliance_config` | 1,000,000 | 18,171,600 | 11,850,300 | **7,321,300** | 0.007321 |
| `shielded_transfer` | 1,000,000 | 14,485,600 | 12,610,224 | **2,875,376** | 0.002875 |
| `zk_withdraw` | 1,000,000 | 15,823,200 | 12,369,456 | **4,453,744** | 0.004454 |
| `propose_compliance_toggle` | 1,000,000 | 11,977,600 | 11,850,300 | **1,127,300** | 0.001127 |
| `compliant_transfer` | 1,000,000 | 22,556,800 | 18,275,796 | **5,281,004** | 0.005281 |

Every row except `publish` (1,380 units) bills exactly the **1,000-unit computation floor** — including the two that verify
Groth16 proofs (`compliant_transfer` verifies two). Net cost is therefore dominated by storage
(`shielded_transfer`: 1,000,000 computation vs 1,875,376 net storage = 35% / 65%; `zk_withdraw`
22% / 78%; `compliant_transfer` 19% / 81%). Every storage figure is a multiple of 7,600 MIST (e.g. 9,021,200 = 1,187 × 7,600), consistent with
100 storage units/byte × 76 MIST/unit; the byte counts are implied, not separately measured.

### Marginal groth16 compute, n repeated verifies in one tx (computation units; 1 unit = 1000 MIST at RGP 1000)

| Operation | transfer (7 inputs) | withdraw (5) | compliance (6) |
|---|---|---|---|
| `prepare_verifying_key` + parse + verify (**what `verifier.move` does today**) | 268 /verify | 248 | 258 |
| `prepare_verifying_key` only | 84 | 84 | 84 |
| verify against a pre-prepared key | 183 | 165 | 174 |

(Slopes from n = 100 → 200: e.g. transfer raw (53,500 − 26,700)/100 = 268.0; prepare
(16,700 − 8,310)/100 = 83.9; prepared (36,800 − 18,500)/100 = 183.0. raw ≈ prepare + prepared:
268 ≈ 84 + 183.)

Consequences:

1. Storing the `PreparedVerifyingKey` saves ≈ 84 units (31% of verification compute, ≈ 84,000 MIST
   at RGP 1000) — the "~82K" comment in `verifier.move` is **confirmed** — **but on today's entry
   points it saves 0 MIST**, because each entry point is under the 1,000-unit floor even with the
   84 units included. It only becomes billable in a tx that exceeds the floor.
2. Floor break-even: raw verification crosses 1,000 units at ≈ 3.7 proofs per tx (measured: n = 2 →
   1,000 floor, n = 5 → 1,350). With a stored PVK ≈ 5.5. **Batching several transfers into one tx
   saves no computation gas until the batch exceeds ≈ 4 proofs**; below that the verifications are
   free riders on the floor. An aggregated single-verification proof (queue #3) would save at most
   ≈ 268 units per additional proof beyond the floor — real, but small next to storage.
3. For the user, **storage** (new commitment + nullifier dynamic fields, rewriting the `Pool` object, which holds the VKs inline) is the cost to optimise, not the verifier. Prover time (queue #2) remains the dominant
   per-transfer cost to the user (≈ 750 ms Node / 1.2 s browser, BASELINE) versus ≈ 0.003 SUI.

### Move contract suite (closes the 2026-07-22 "NOT RUN" gap)

```
$ cd contracts && sui move test
Test result: OK. Total tests: 124; passed: 124; failed: 0
```

### Incidental security finding — E7 is not mitigated on-chain

`threat-model.md` E7 ("front-run ZK withdrawal") is marked Mitigated because the circuit constrains
`recipientHash = Poseidon(8, recipient)`. But `pool::zk_withdraw` never recomputes that hash from
its `recipient: address` argument or compares it to bytes 96–128 of the public inputs (the code
comment at `pool.move:595-599` asserts the proof "verifies" this, which it cannot: the proof only
proves the *witness* recipient matches the public hash, and the contract never ties the public hash
to the argument). Anyone who sees a withdrawal transaction before execution — the submitting
relayer, a validator/fullnode operator, anyone the user hands the proof to — can resubmit the same
proof and inputs with their own address as `recipient`. Demonstrated on localnet: the proof bound
`recipientHash` to `0xabcdef123456`, the tx paid the sender's own address, the tx succeeded:

```
  E7 check: proof bound recipientHash to abcdef123456, tx paid 0x86fcb838…5af021; TOKEN balance 0 -> 100 (delta 100)
```

Impact: a malicious/compromised relayer (RR7 model) or any party that learns the proof before
inclusion can redirect the withdrawal, subject to winning the race on the nullifier. Not fixed
tonight (contract + frontend change, needs a design decision — see Open questions). `threat-model.md`
E7 is downgraded in this PR.

### Raw output

`node bench/gas-localnet.ts --json out.json` (from `scripts/`, localnet running):

```
reference gas price: 1000 MIST/unit
== publish
  publish                            comp=1380000 storage=156415600 rebate=4890600 net=152905000
== setup
  create_pool                        comp=1000000 storage=8496800 rebate=978120 net=8518680
  faucet                             comp=1000000 storage=4043200 rebate=2678544 net=2364656
  deposit_and_register #1            comp=1000000 storage=9021200 rebate=8223732 net=1797468
  faucet                             comp=1000000 storage=4043200 rebate=2678544 net=2364656
  deposit_and_register #2            comp=1000000 storage=9021200 rebate=8223732 net=1797468
  faucet                             comp=1000000 storage=4043200 rebate=2678544 net=2364656
  deposit_and_register #3            comp=1000000 storage=9021200 rebate=8223732 net=1797468
  update_commitment_root (propose)   comp=1000000 storage=8740000 rebate=8411832 net=1328168
  propose_withdraw_vk                comp=1000000 storage=11970000 rebate=8652600 net=4317400
  create_compliance_config           comp=1000000 storage=18171600 rebate=11850300 net=7321300
== waiting for epoch 29864603 (timelocks + maturity)
== shielded_transfer
  shielded_transfer                  comp=1000000 storage=14485600 rebate=12610224 net=2875376
== zk_withdraw
  zk_withdraw                        comp=1000000 storage=15823200 rebate=12369456 net=4453744
  E7 check: proof bound recipientHash to abcdef123456, tx paid 0x86fcb838405a95309bf80bf3797bd004444bdab2e783539a5fff5108545af021; TOKEN balance 0 -> 100 (delta 100)
  propose_compliance_toggle          comp=1000000 storage=11977600 rebate=11850300 net=1127300
== waiting for epoch 29864604
== compliant_transfer
  compliant_transfer                 comp=1000000 storage=22556800 rebate=18275796 net=5281004

| Entry point | computation (MIST) | computation units | storage (MIST) | rebate (MIST) | net (MIST) | net (SUI) |
|---|---|---|---|---|---|---|
| publish | 1380000 | 1380 | 156415600 | 4890600 | 152905000 | 0.152905 |
| create_pool | 1000000 | 1000 | 8496800 | 978120 | 8518680 | 0.008519 |
| deposit_and_register #1 | 1000000 | 1000 | 9021200 | 8223732 | 1797468 | 0.001797 |
| deposit_and_register #2 | 1000000 | 1000 | 9021200 | 8223732 | 1797468 | 0.001797 |
| deposit_and_register #3 | 1000000 | 1000 | 9021200 | 8223732 | 1797468 | 0.001797 |
| update_commitment_root (propose) | 1000000 | 1000 | 8740000 | 8411832 | 1328168 | 0.001328 |
| propose_withdraw_vk | 1000000 | 1000 | 11970000 | 8652600 | 4317400 | 0.004317 |
| create_compliance_config | 1000000 | 1000 | 18171600 | 11850300 | 7321300 | 0.007321 |
| shielded_transfer | 1000000 | 1000 | 14485600 | 12610224 | 2875376 | 0.002875 |
| zk_withdraw | 1000000 | 1000 | 15823200 | 12369456 | 4453744 | 0.004454 |
| propose_compliance_toggle | 1000000 | 1000 | 11977600 | 11850300 | 1127300 | 0.001127 |
| compliant_transfer | 1000000 | 1000 | 22556800 | 18275796 | 5281004 | 0.005281 |
```

`node bench/gas-probe.ts`:

```
== transfer (7 public inputs)
  verify_raw       n=1: 1000 units | n=2: 1000 units | n=5: 1350 units | n=10: 2680 units | n=20: 5340 units | n=50: 13400 units | n=100: 26700 units | n=200: 53500 units
  prepare_only     n=1: 1000 units | n=2: 1000 units | n=5: 1000 units | n=10: 1000 units | n=20: 1680 units | n=50: 4170 units | n=100: 8310 units | n=200: 16700 units
  verify_prepared  n=1: 1000 units | n=2: 1000 units | n=5: 1020 units | n=10: 1940 units | n=20: 3770 units | n=50: 9260 units | n=100: 18500 units | n=200: 36800 units

== withdraw (5 public inputs)
  verify_raw       n=1: 1000 units | n=2: 1000 units | n=5: 1260 units | n=10: 2490 units | n=20: 4960 units | n=50: 12400 units | n=100: 24800 units | n=200: 49600 units
  prepare_only     n=1: 1000 units | n=2: 1000 units | n=5: 1000 units | n=10: 1000 units | n=20: 1680 units | n=50: 4160 units | n=100: 8310 units | n=200: 16700 units
  verify_prepared  n=1: 1000 units | n=2: 1000 units | n=5: 1000 units | n=10: 1740 units | n=20: 3380 units | n=50: 8300 units | n=100: 16500 units | n=200: 33000 units

== compliance (6 public inputs)
  verify_raw       n=1: 1000 units | n=2: 1000 units | n=5: 1300 units | n=10: 2590 units | n=20: 5150 units | n=50: 12900 units | n=100: 25700 units | n=200: 51500 units
  prepare_only     n=1: 1000 units | n=2: 1000 units | n=5: 1000 units | n=10: 1000 units | n=20: 1680 units | n=50: 4160 units | n=100: 8310 units | n=200: 16700 units
  verify_prepared  n=1: 1000 units | n=2: 1000 units | n=5: 1000 units | n=10: 1840 units | n=20: 3570 units | n=50: 8780 units | n=100: 17500 units | n=200: 34900 units
```

CI suite (all green on this branch): `sui move build` ok, `sui move test` 124/124, `circuits npm test`
(transfer 43/43, compliance and withdraw suites pass, withdraw 35/35), `test-converter`,
`test-compliance-utils`, `fuzz-tests` (6/6 properties), frontend `tsc --noEmit`, `biome check`,
`vitest` 19/19.

## Verdict

**KEEP.** BASELINE.md gas row filled in; Move suite verified. Caveats: single-sample per row
(storage is deterministic; computation sits on the floor), localnet constants, not mainnet RGP.
The E7 finding is recorded as the top queue item.

## Where this could be used

- Any Sui protocol that verifies Groth16 on-chain (private voting, ZK-gated airdrops, rollup-style
  settlement on Sui): the finding that `sui::groth16` verification of a 5–7 input circuit costs
  only ≈ 170–270 compute units, i.e. under the 1,000-unit floor, means per-tx verification is
  effectively free and the design budget belongs to storage layout. Specific: a confidential payroll
  run on Sui settling ≈ 4 payments per PTB incurs *no* additional computation fee over one.
- Thesis chapter: "cost model of on-chain SNARK verification on an object-centric chain" — the
  floor/bucket analysis and the `gas-probe` method are reusable for any Move package.
- Relayer fee design: with net ≈ 0.003–0.005 SUI per private transaction a relayer can quote a flat
  fee; the real cost to users is prover time, not gas.

## Open questions (tomorrow's queue)

1. **Fix E7**: bind `recipient` on-chain. Options: recompute Poseidon via `sui::poseidon` and compare
   (needs address→field reduction, addresses can exceed BN254 `r`), or take the recipient as two
   128-bit limbs in the public inputs. Needs a circuit/VK change → soundness argument, leakage
   analysis, negative test, and a regression test (real-proof Move test is hard; extend
   `gas-localnet.ts` with a rejected-redirect assertion).
2. Storage is the cost: can the new-commitment + nullifier pair be one dynamic field, or the VKs
   moved out of `Pool` (which is rewritten on every tx) into a separate object?
3. Concurrency: shared-object contention on `Pool` under parallel transfers (not measured —
   needs multiple signers).
4. Re-measure on testnet when RPC is permitted, to check RGP/storage-price scaling.
