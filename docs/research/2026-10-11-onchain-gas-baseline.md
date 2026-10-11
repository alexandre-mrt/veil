# 2026-10-11 — On-chain gas per entry point (queue item #1)

## Hypothesis

Groth16 verification is the dominant on-chain cost of `shielded_transfer`: it accounts for **≥ 50 %
of the transaction's net gas**, so proof aggregation (queue item #3, N transfers → 1 verify) is the
highest-leverage gas lever Veil has.

Falsifiable by measuring (a) the net gas of every entry point with real proofs and (b) the marginal
cost of one `sui::groth16` verification, and dividing. **Result: refuted** — verification is
~270,000 MIST of a 2,872,944 MIST transaction (9.4 %), and it is billed inside a 1,000,000 MIST
computation floor that every Veil call pays whether or not it verifies anything. Storage is 65 % of
the net bill. Details below.

This is a measurement night: no circuit, Move module, or frontend code was changed.

## Threat / privacy model

No protocol property changes, so no new adversary is defended against. The relevant adversaries are
the ones for whom *cost* is a lever:

- **Griefing / state-bloat attacker** (STRIDE D3, `docs/threat-model.md`): wants to exhaust or
  bloat pool state. D3's mitigation is the standard-denomination deposit (≥ 100 TOKEN). This run
  puts a measured price on the SUI side of that attack: one `deposit_and_register` costs the
  attacker **3,135,068 MIST net (0.0031 SUI)** plus the 100 TOKEN, and permanently adds one
  dynamic field to the pool.
- **Chain observer** : gas is public. All entry points are fixed-shape (no data-dependent
  branches on secrets), so computation/storage figures are identical across users for a given entry
  point and leak nothing beyond which entry point was called. This run did not test that
  empirically beyond observing that the two `deposit_and_register` rows are byte-identical.

What this does **not** establish: anything about mainnet pricing (see Assumptions), anything about
the `compliant_transfer` / compliance-config paths (not driven tonight), or the relayer (gas payer
is separate — `docs/threat-model.md` I3).

Assumptions: (1) localnet gas parameters match the protocol config of the Sui revision the contracts
pin (`94ad8ccd`, built into `sui 1.72.1`): reference gas price **1000 MIST/unit** (read back via
`suix_getReferenceGasPrice`), storage price consistent with **76 MIST per storage unit** (gross
storage figures divide exactly by 7,600 MIST/byte). Mainnet's reference gas price floats per epoch and
may differ — treat the *shape* (what dominates, relative ratios) as the finding and the MIST
absolutes as localnet-at-RGP-1000. (2) Proofs are valid Groth16 proofs from the dev zkeys; gas does
not depend on proof provenance.

STRIDE mapping: D3 (state spam) — priced above. No other entry affected.

## Approach

**What I built** (all reusable, all under `scripts/bench/`):

- `gas-local.ts` — publishes `contracts/` to a fresh localnet and drives the real flow with real
  proofs: `publish`, `create_pool`, faucet mint, 2× `deposit_and_register`,
  `update_commitment_root` (propose), `propose_withdraw_vk`, wait out the 1-epoch timelocks
  (epoch = 60 s, the contract minimum), then `shielded_transfer` and `zk_withdraw`. Gas is read
  from the `effects.gasUsed` the network returns for each transaction.
- `gas-proofs.mjs` — produces the proofs under Node. (Under Bun, `snarkjs.groth16.fullProve`
  never resolves — its worker threads are not scheduled — and the process exits 0 silently with
  work unfinished; I lost ~10 minutes to that before moving proving to a Node subprocess.)
- `gas-probe/` — a 3-function Move wrapper around `sui::groth16` (`verify_full`, `prepare_only`,
  `noop`). Because every Veil entry point lands in the minimum computation bucket, a single verify
  can't be resolved from the entry-point rows alone. The probe lets a PTB call the *exact* verifier
  sequence `veil::verifier` uses N times in one transaction, so the bucketed bill climbs through
  its boundaries and the per-call cost falls out as a slope. Bench-only; never deployed anywhere
  but the local network.

**Toolchain.** `sui` was the blocker twice (see LEDGER 2026-07-22). `github.com/MystenLabs/sui`
*release* downloads and the Sui testnet fullnode are both policy-denied from this sandbox (403 at
the proxy — not retried), but `git fetch` of the source works. I built the CLI from source at the
exact revision `contracts/Move.toml` pins: `cargo build --release --bin sui` on 4 cores took
**45 m 52 s** (log: `Finished release profile [optimized + debuginfo] target(s) in 45m 52s`), and
`sui --version` reports `sui 1.72.1-94ad8ccd0ed6`. Building the pinned rev also guarantees the
framework the contracts compile against matches the VM that runs them.

The Hermez `powersOfTau28_hez_final_15.ptau` is no longer downloadable (`storage.googleapis.com`
returns `AccessDenied` for the public object; the S3 mirror returned an error body). I generated a
fresh pot15 locally (`snarkjs powersoftau new/contribute/prepare phase2`, 12.5 min) — **dev-only,
single party, not for any real use**. It affects nothing measured here: constraint counts
reproduced exactly (transfer 6,470 non-linear + 7,141 linear = 13,611), and gas does not depend on
the SRS. It does mean the *proving-time* rows in `BASELINE.md` were not re-run tonight.

**Alternatives rejected.**
- Read historical gas from the deployed testnet package with `suix_queryTransactionBlocks`: the
  fullnode is denied by organization policy (`CONNECT` → 403). Not retried.
- `sui move test` gas statistics: unit tests don't charge the real gas schedule or storage, so
  they can't produce a number comparable to an executed transaction.
- Estimating verify cost from protocol-config constants alone: kept only as a cross-check
  (below), because a number from the config isn't a measurement.

## Results

Baseline = none (these axes had never been measured: `BASELINE.md` "On-chain gas" was BLOCKED).
Gas in MIST (1 SUI = 10⁹ MIST), `net = computation + storage − storage rebate`. Localnet,
RGP 1000.

### Gas per entry point (real proofs)

| Entry point | Computation | Storage (gross) | Storage rebate | **Net** | Net, SUI |
|---|---:|---:|---:|---:|---:|
| `publish` (veil package) | 1,380,000 | 156,415,600 | 4,890,600 | **152,905,000** | 0.1529 |
| `create_pool` | 1,000,000 | 8,496,800 | 978,120 | **8,518,680** | 0.0085 |
| `token_faucet::faucet` (testnet only) | 1,000,000 | 4,043,200 | 2,678,544 | 2,364,656 | 0.0024 |
| `deposit_and_register` | 1,000,000 | 10,358,800 | 8,223,732 | **3,135,068** | 0.0031 |
| `update_commitment_root` (propose) | 1,000,000 | 8,740,000 | 8,411,832 | **1,328,168** | 0.0013 |
| `propose_withdraw_vk` | 1,000,000 | 11,970,000 | 8,652,600 | **4,317,400** | 0.0043 |
| `shielded_transfer` (Groth16, 7 inputs) | 1,000,000 | 14,242,400 | 12,369,456 | **2,872,944** | 0.0029 |
| `zk_withdraw` (Groth16, 5 inputs) | 1,000,000 | 15,580,000 | 12,128,688 | **4,451,312** | 0.0045 |

Not driven tonight: `compliant_transfer`, `create_compliance_config`, the other admin/timelock
entry points, `emergency_withdraw`. (Compliance needs a second VK, credential tree, and auditor
key wiring; left to a follow-up.)

### Isolating the verifier: N × `sui::groth16` in one transaction (computation only)

Per-call figures are the slope between N = 50 and N = 100 (N = 25→50 agrees within 1.3 %). The `noop`
control (same arguments, no crypto) stays at the 1,000,000 floor for every N up to 100, so none of
this is argument-passing overhead.

| Primitive | N=1 | N=5 | N=10 | N=25 | N=50 | N=100 | **Per call (MIST)** |
|---|---:|---:|---:|---:|---:|---:|---:|
| `noop` control | 1.00M | 1.00M | 1.00M | 1.00M | 1.00M | 1.00M | 0 |
| `prepare_only` (transfer VK) | 1.00M | 1.00M | 1.00M | 2.11M | 4.21M | 8.44M | **≈ 84,600** |
| `verify_full` transfer (7 inputs) | 1.00M | 1.35M | 2.69M | 6.70M | 13.40M | 26.90M | **≈ 270,000** |
| `verify_full` withdraw (5 inputs) | 1.00M | 1.26M | 2.50M | 6.22M | 12.50M | 24.90M | **≈ 248,000** |

Cross-check against the protocol config at the pinned revision (not a measurement, a sanity
check on the measurement): `prepare_verifying_key_bn254` = 82,010; `verify_groth16_proof_internal_bn254`
= 115,502 + 9,484 per public input. Transfer: 82,010 + 115,502 + 7·9,484 = **263,900** (measured
≈ 270,000); withdraw: 82,010 + 115,502 + 5·9,484 = **244,932** (measured ≈ 248,000). The ~2 %
residual is byte-parsing of VK/proof/inputs. Config units are 1 MIST at RGP 1000, i.e. the
`~82K gas` comment in `contracts/sources/verifier.move` is MIST at RGP 1000 — correct, and worth
0.000082 SUI per call.

### What the numbers say

| Quantity | Value |
|---|---|
| Verify share of `shielded_transfer` net gas | 270,000 / 2,872,944 = **9.4 %** (hypothesis: ≥ 50 %) |
| Computation share of `shielded_transfer` net | 1,000,000 / 2,872,944 = 34.8 % — all of it the floor |
| Net-storage share | 1,872,944 / 2,872,944 = **65.2 %** |
| Verify cost as a fraction of the computation floor | 27 % — one transfer's verify fits in the floor ~3.7× |
| `prepare_verifying_key` share of one verify | 84,600 / 270,000 = 31 % |

Consequences: (1) removing verification entirely (a perfect aggregation of N→1 with zero marginal
cost) would **not lower the bill at all** for a single transfer, because computation is already
quantized to the 1,000,000 floor; (2) caching the `PreparedVerifyingKey` in the pool (the
optimization noted in `verifier.move`) saves 84,600 MIST of metered computation but 0 MIST of
billed computation, again because of the floor; (3) the real cost driver is storage: a transfer
writes ≈ 1,874 bytes of new state (14,242,400 / 7,600), a nullifier that is never deleted plus a
commitment (the rebate reflects the consumed old commitment and re-priced pool object; I did not
break the 1,874 bytes down further — open question 1).

### Context for `BASELINE.md`'s second blocked row — Move test suite

```
$ cd contracts && sui move test
...
Test result: OK. Total tests: 124; passed: 124; failed: 0
```

### Raw output (`bun run bench/gas-local.ts`, abridged to the entry-point rows)

```
[gas] publish (package)                  comp=1380000 storage=156415600 rebate=4890600 net=152905000
[gas] create_pool                        comp=1000000 storage=8496800 rebate=978120 net=8518680
[gas] token_faucet::faucet (mint 1000)   comp=1000000 storage=4043200 rebate=2678544 net=2364656
[gas] deposit_and_register (1st)         comp=1000000 storage=10358800 rebate=8223732 net=3135068
[gas] deposit_and_register (2nd)         comp=1000000 storage=10358800 rebate=8223732 net=3135068
[gas] update_commitment_root (propose)   comp=1000000 storage=8740000 rebate=8411832 net=1328168
[gas] propose_withdraw_vk                comp=1000000 storage=11970000 rebate=8652600 net=4317400
[wait] 98 s for timelocks / maturity (epoch = 60000 ms)
[gas] shielded_transfer (Groth16, 7 inputs) comp=1000000 storage=14242400 rebate=12369456 net=2872944
[gas] zk_withdraw (Groth16, 5 inputs)    comp=1000000 storage=15580000 rebate=12128688 net=4451312
[gas] probe prepare_only x25 [transfer (7 inputs)] comp=2110000 ...
[gas] probe verify_full x100 [transfer (7 inputs)] comp=26900000 ...
[gas] probe verify_full x100 [withdraw (5 inputs)] comp=24900000 ...
```

(An earlier identical run, before the probe phase was added, produced byte-identical
entry-point rows: gas is deterministic for these calls.)

Reproduce (from the repo root; prerequisites in the header of `gas-local.ts`):

```
sui start --force-regenesis --with-faucet &          # sui 1.72.1 built from rev 94ad8ccd
bash circuits/scripts/compile.sh && bash circuits/scripts/compile-withdraw.sh   # needs pot15_final.ptau
cd scripts && bun install && bun run bench/gas-local.ts --out gas.json
```

### Full test suite (all green; run before opening this PR)

```
Move:                 Total tests: 124; passed: 124; failed: 0
transfer.circom:      Results: 43 passed, 0 failed
compliance.circom:    Results: 30 passed, 0 failed
withdraw.circom:      Results: 35 passed, 0 failed
test-converter.ts:    All tests passed.
test-compliance-utils.ts: All tests passed.
fuzz-tests.ts:        ALL 6 PROPERTIES PASSED
frontend (vitest):    Tests 19 passed (19)
```

## Verdict

**KEEP** (partial). `BASELINE.md` gets its on-chain gas table and the Move-suite row; the
hypothesis is refuted, which is the useful outcome — queue item #3 (aggregated verification) loses
most of its gas rationale and is re-ranked down; a new storage-focused item is added.

Caveats that bound the claim: localnet at RGP 1000, not mainnet; `compliant_transfer` unmeasured;
one run per row (rows were byte-identical across two runs, so variance is zero for these calls).

## Where this could be used

- **Any Sui protocol that verifies Groth16 on-chain** (private voting, zk-login-style attestations,
  private airdrops): the finding that a BN254 verify with ≤ 7 public inputs costs ≈ 0.25–0.27 of the
  1,000,000-MIST computation floor (≈ 3–4 verifies fit in the floor) is a reusable rule of thumb —
  *per-tx* batching up to ~3 verifies is free; aggregation only pays beyond that. The `gas-probe`
  pattern (N calls per PTB to cross bucket boundaries) generalises to pricing any Move native.
- **Thesis chapter on scalability economics**: "what does a private transfer cost, and who pays" —
  the 65 % storage share argues the scalability section should be framed around state growth
  (nullifier set + commitment set), not verifier cost.
- **Confidential payroll on Sui with a t-of-n auditor board**: a monthly payroll run of 200 payees
  is 200 × 0.0029 SUI ≈ 0.57 SUI of net gas today, nearly all storage; an operator budgeting that
  deployment should plan for nullifier-state growth, not compute.

## Open questions (→ tomorrow's queue)

1. **Storage is 65 % of the bill.** What is the byte-level breakdown of a transfer's 1,874 bytes
   (two dynamic fields + `TransferEvent` + pool mutation)? Can the nullifier set be stored as a
   `Table`/bag with a smaller per-entry footprint, or batched into a single accumulator object? A
   measured byte diff, same harness.
2. **Is the 1,000,000 floor a permanent feature at mainnet RGP?** Re-run the harness against a
   localnet with `--with-faucet` at a different RGP (genesis config `gas_price`) to confirm the
   floor scales and the verify-share ratio holds.
3. **Multi-transfer PTB**: since ~3.7 verifies fit inside the floor, do 3 `shielded_transfer`
   calls in one PTB cost ≈ 1 transfer's computation? (Needs 3 distinct valid proofs; the harness
   is ready for it.) That would be a free 3× on-chain-verify amortization with no circuit change.
4. **Compliance path gas**: `compliant_transfer` verifies two proofs (transfer + compliance).
   Measure it — it's the only entry point where computation could exceed the floor.
5. The localnet PTB limits: how many verifies fit in one PTB before the max-gas-computation bucket
   is hit (relevant to any future aggregation scheme).
