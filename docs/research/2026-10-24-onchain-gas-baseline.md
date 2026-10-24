# 2026-10-24 — On-chain gas baseline (queue item #1)

## Hypothesis

Every Veil entry point, including the three that verify a Groth16 proof (`shielded_transfer`,
`compliant_transfer`, `zk_withdraw`), can be measured for real on-chain gas by executing it with real
proofs on a Sui localnet. That fills the one axis `BASELINE.md` left **BLOCKED** (0 of 12 measured
entry points → 12 of 12), and shows how much of that gas is Groth16 verification.

Stated as a falsifiable number: *"the `veil::verifier` native calls account for most of the
computation gas of a Veil transfer, so a cheaper or batched verifier is where gas savings live."*
**This was refuted** (see Results): verification is ~267 computation units against a 1,000-unit
floor, and storage, not computation, dominates every transaction.

## Threat / privacy model

No protocol change, so no new defence. The relevant adversaries are about gas as a *resource*:

- **Griefing / DoS-by-cost attacker** — wants to make transfers expensive for others or the relayer.
  Gas is what the relayer pays for sponsored txs (threat-model D1/D2); this baseline is the first real
  number for how much a relayer spends per relayed Veil operation.
- **Chain observer** — sees gas payer, gas used and object changes of every tx. Gas is a
  fingerprint: `shielded_transfer` (net 2,875,376 MIST) vs `compliant_transfer` (5,288,528) vs
  `zk_withdraw` (4,453,744) are distinguishable by gas alone, which is moot today because the entry
  point is public in the PTB, but it matters for any future "single mixed entry point" design.

Not defended / not established: nothing about soundness, anonymity-set size or the trusted setup
(RR2) is touched. Measured on a *localnet* at reference gas price 1000 MIST/unit; testnet/mainnet
differ in gas price and storage price (storage price is a protocol constant, so storage figures
should carry over; computation is bucketed by the live gas price). Assumption: the `sui` v1.72.2
binary's gas schedule matches the framework rev pinned in `contracts/Move.toml`
(`94ad8cc…`, in tag `mainnet-v1.72.2`).

STRIDE mapping: D1/D2 (relayer cost), D3 (cost to spam deposits). **Side finding that does map to
STRIDE:** S3 / S2-adjacent — see "Soundness finding" below; recorded as new residual risk RR10 in
`docs/threat-model.md`.

## Approach

Built two reusable harnesses (nothing in the protocol changed):

- `scripts/bench/gas-localnet.ts` — publishes the real `contracts/` package to a local Sui network,
  runs the full lifecycle with real Groth16 proofs for all three circuits, and reads
  `effects.gasUsed` of every tx. It builds a 2-leaf commitment tree so `shielded_transfer` and
  `compliant_transfer` share one on-chain root, waits across the epoch boundary the timelocks
  require, and local-verifies each proof before submitting.
- `scripts/bench/gas-probe.ts` + `scripts/bench/gas-probe/` (tiny Move package, **not** part of the
  protocol) — added after the first harness showed every tx landing in the lowest computation bucket,
  which hides the verifier's real cost. It calls the same `sui::groth16` natives as `veil::verifier`
  n times in one tx (dry-run, real proofs) and reads the bucketed computation cost; the slope over
  large n is the per-call cost.

Rejected alternatives: (1) JSON-RPC reads of the deployed testnet package — fullnode hosts are
403'd by this sandbox's network policy (proxy status log shows `fullnode.testnet.sui.io:443`
CONNECT rejected); (2) building the Sui workspace from source — unnecessary, prebuilt release
binaries on `github.com/MystenLabs/sui/releases` are reachable; (3) `sui move test --statistics`
— reports Move-VM instruction counts, not Sui's metered gas.

Toolchain notes that cost time and are worth remembering: the `sui` binary must match the framework
rev (v1.60.0 *builds* the package but fails `sui move test`; v1.68.1 passes tests but the publish
fails `VMVerificationOrDeserializationError` against its older on-chain framework; v1.72.2 works);
`sui client publish` refuses a `local` env, use `sui client test-publish --build-env testnet`; the
Hermez ptau URL in `circuits/scripts/compile.sh` now returns 403, so a throwaway local
`powersoftau new/contribute/prepare phase2` (2^15, one contribution) was used — gas does not depend
on the ptau; bun exits silently mid-proof inside snarkjs, so the harnesses run under node 22
(`--experimental-strip-types`).

## Results

### Gas per entry point (`node --experimental-strip-types --no-warnings bench/gas-localnet.ts`, from `scripts/`)

Sui localnet 1.72.2, reference gas price 1000. All values MIST. `net = computation + storage − rebate`.
Re-run twice: identical to the digit except the `create_pool` rebate (depends on the gas coin used).

| Entry point | Computation | Storage | Rebate | **Net** |
|---|---|---|---|---|
| publish (whole package) | 1,370,000 | 156,415,600 | 978,120 | 156,807,480 |
| `create_pool` | 1,000,000 | 8,496,800 | 978,120 | 8,518,680 |
| `deposit_and_register` (identical ×3, pool size 0→2) | 1,000,000 | 10,358,800 | 8,223,732 | **3,135,068** |
| `update_commitment_root` (propose) | 1,000,000 | 8,740,000 | 8,411,832 | 1,328,168 |
| `propose_withdraw_vk` | 1,000,000 | 11,970,000 | 8,652,600 | 4,317,400 |
| `create_compliance_config` | 1,000,000 | 18,171,600 | 11,850,300 | 7,321,300 |
| `shielded_transfer` | 1,000,000 | 14,485,600 | 12,610,224 | **2,875,376** |
| `compliant_transfer` (transfer + compliance proof) | 1,000,000 | 22,556,800 | 18,268,272 | **5,288,528** |
| `zk_withdraw` | 1,000,000 | 15,823,200 | 12,369,456 | **4,453,744** |

(1 SUI = 10⁹ MIST: a shielded transfer costs ≈ 0.0029 SUI net.) `token_faucet::faucet` (test mint,
not protocol) = 2,364,656.

Two facts the table shows: **computation is exactly 1,000,000 MIST (the minimum, 1000-unit bucket)
for every Veil call**, so all variation between entry points is storage; and deposits are flat in
pool size (3 identical rows) because state is dynamic fields, not a vector.

### Isolating the verifier (`node --experimental-strip-types --no-warnings bench/gas-probe.ts`)

Computation **units** (= computationCost / 1000) of a tx doing n repetitions, real proofs:

```
[probe] transfer   noop                   {"1":1000,"2":1000,"4":1000,"8":1000,"16":1000,"32":1000,"64":1000,"128":1000,"256":1000,"512":1000,"1024":1000}
[probe] transfer   prepare_n              {"1":1000,"2":1000,"4":1000,"8":1000,"16":1350,"32":2670,"64":5330,"128":10700,"256":21400,"512":42900,"1024":-1}
[probe] transfer   verify_prepared_n      {"1":1000,"2":1000,"4":1000,"8":1570,"16":3030,"32":5960,"64":11900,"128":23600,"256":47100,"512":94100,"1024":-1}
[probe] transfer   prepare_and_verify_n   {"1":1000,"2":1000,"4":1090,"8":2150,"16":4280,"32":8530,"64":17100,"128":34200,"256":68400,"512":-1}
[probe] withdraw   noop                   {"1":1000,"2":1000,"4":1000,"8":1000,"16":1000,"32":1000,"64":1000,"128":1000,"256":1000,"512":1000,"1024":1000}
[probe] withdraw   prepare_n              {"1":1000,"2":1000,"4":1000,"8":1000,"16":1350,"32":2670,"64":5320,"128":10700,"256":21400,"512":42800,"1024":-1}
[probe] withdraw   verify_prepared_n      {"1":1000,"2":1000,"4":1000,"8":1420,"16":2730,"32":5350,"64":10600,"128":21100,"256":42100,"512":84300,"1024":-1}
[probe] withdraw   prepare_and_verify_n   {"1":1000,"2":1000,"4":1010,"8":2000,"16":3970,"32":7920,"64":15900,"128":31700,"256":63500,"512":-1}
[probe] compliance noop                   {"1":1000,"2":1000,"4":1000,"8":1000,"16":1000,"32":1000,"64":1000,"128":1000,"256":1000,"512":1000,"1024":1000}
[probe] compliance prepare_n              {"1":1000,"2":1000,"4":1000,"8":1000,"16":1350,"32":2670,"64":5330,"128":10700,"256":21400,"512":42800,"1024":-1}
[probe] compliance verify_prepared_n      {"1":1000,"2":1000,"4":1000,"8":1490,"16":2880,"32":5660,"64":11300,"128":22400,"256":44600,"512":89200,"1024":-1}
[probe] compliance prepare_and_verify_n   {"1":1000,"2":1000,"4":1050,"8":2070,"16":4120,"32":8220,"64":16500,"128":33000,"256":65900,"512":-1}
```
(`-1` = dry run did not succeed at that n, i.e. hit the execution gas ceiling; ladder stops there.)

Slopes (units per call, n=256 / n=128 agree to ±0.5): `prepare_verifying_key` **83.6** for all three
VKs; verify with a prepared VK **184.0 / 164.5 / 174.2** (transfer / withdraw / compliance);
what `veil::verifier` does today (prepare + verify) **267.2 / 248.0 / 257.4**.

| | Baseline (measured) | Derived |
|---|---|---|
| Verifier cost per `shielded_transfer` | 267 units ≈ 267,000 MIST | 27% of the 1,000-unit floor bucket |
| `prepare_verifying_key` share | 83.6 units | 31% of verifier cost; the `verifier.move` comment claiming "~82K gas" is **confirmed** (83.6K internal) |
| Max proofs per tx before leaving the floor bucket | 3 (n=4 → 1,090 units for transfer) | |
| Batch cost of N transfer proofs/tx (prepare+verify) | ≈ 267·N units; 1,000 → 5,000 bucket at N≈19 | |

### Verdict-relevant reading

- **Storing a `PreparedVerifyingKey` (the optimisation `verifier.move` proposes) saves ~84 units but
  0 MIST today**: a transfer sits at ~300 units, inside the 1,000-unit floor bucket, and is billed
  1,000. It would only start to pay once a tx exceeds ~1,000 units (≥4 verifications in one PTB).
- **Aggregating/batching proofs to cut gas is aimed at the wrong term.** Up to 3 verifications per tx
  are free relative to the floor; the dominant, *un-batchable-by-verification* cost is storage:
  14.5M gross for a transfer (new commitment + nullifier dynamic fields; the 12.6M rebate is mostly
  the consumed old-commitment field + gas-object churn). Reducing state written per transfer (e.g.
  one accumulator update per batch instead of two dynamic fields per transfer) is the lever.
- **Gas does not grow with pool size** (deposit rows identical).

## Soundness finding (unplanned, **confirmed on localnet**): compliance proof is not bound to the transfer

While wiring `compliant_transfer` I noticed `compliance.move` never reads or compares the compliance
proof's `contextId` (bytes 64..96 of its inputs) — `grep -n context contracts/sources/compliance.move`
returns nothing. The circuit makes `contextId = Poseidon(6, transferNullifier, userSecret)`, but
`transferNullifier` is a *private* compliance input, so the chain cannot recompute or check it, and
the transfer proof contains no corresponding public value. Test (`DECOUPLE=1 … gas-localnet.ts`):
pair a **valid transfer proof of user A, who holds no credential** with the **compliance proof of
credential-holder B** (generated for B's own unrelated `transferNullifier`).

```
[gas] compliant_transfer (A's transfer + B's credential proof) computation=1000000 storage=22556800 rebate=18509040 net=5047760 MIST
```
Accepted on-chain (status success). So a KYC credential holder can mint compliance proofs
(each with a fresh `transferNullifier` ⇒ fresh credential nullifier) and hand them to anyone;
the "compliant" gate does not show that the *sender of this transfer* is KYC'd. `docs/threat-model.md`
S3 / the controls table claim "context-bound credential nullifiers"; the binding exists only inside
the circuit, not between the two proofs. Not fixed here (circuit + contract change, needs the
soundness/leakage/negative-test package). Recorded as RR10 and queued.

## Verdict

**KEEP.** `BASELINE.md` updated in place (gas table; Move suite now RUN: 124/124 pass under sui
1.72.2). The numerical hypothesis ("verifier dominates gas") was refuted, which is a result.
Full CI-equivalent suite green: `sui move test` 124/124, circuits 43+30+35 pass, scripts
converter/compliance-utils/fuzz pass, frontend `tsc`, `biome`, `vitest` 19/19 pass.

## Where this could be used

- **Any Sui privacy pool paying per-transfer verification**: the finding that Groth16 BN254 verify
  costs ≈250–270 units against a 1,000-unit floor means 3 independent proofs per PTB are "free" —
  relevant to a *confidential payroll on Sui* batching ≤3 employee payouts per tx, and to rollup-style
  aggregators deciding whether on-chain aggregation is worth it (it is not, below ~19 proofs/tx).
- **Thesis chapter on cost models of on-chain ZK verification**: bucketed computation + storage-
  dominated billing is Sui-specific and differs from EVM calldata/pairing-precompile pricing.
- **Relayer economics** (sponsored-tx fee schedule): ≈0.003–0.005 SUI per relayed op.
- The soundness finding applies to *any* two-proof "transfer + compliance" design on a chain where
  the second proof's context cannot be recomputed from public data (e.g. travel-rule compliant
  stablecoin transfers with ZK-KYC).

## Open questions (→ queue)

1. Fix the compliance-binding gap: expose a public binding value shared by both proofs (e.g. add
   `contextId` as a public input of the transfer circuit, or make the transfer nullifier public to the
   compliance circuit's check) — circuit change, needs soundness + leakage + negative test.
2. Storage is the cost: how few bytes/dynamic fields can a transfer write? Measure gas vs.
   "batch accumulator update" design; measure `nonRefundableStorageFee` impact on long-lived nullifiers.
3. Measure gas on shared-object contention (concurrent transfers on one `Pool`) — the localnet
   harness can drive N parallel PTBs.
4. Re-run on testnet if the sandbox ever allows fullnode access, to confirm localnet ≈ testnet.
5. `scripts/src/e2e-test.ts` and `e2e-compliance-test.ts` are stale against the current contract
   (`create_pool` now takes `epoch_duration_ms`, `deposit_and_register` takes a `Clock`, the
   transfer circuit has 7 public inputs); `gas-localnet.ts` is a working replacement.
