# 2026-11-18 — On-chain gas per entry point (and two fund-loss findings it surfaced)

Queue item #1 (blocked on 2026-07-22). Tonight it is unblocked and measured: a `sui` CLI built
from source at the exact framework rev `contracts/Move.lock` pins, a real localnet, real Groth16
proofs, real transactions. The same harness turned up two critical, fund-loss bugs in
`zk_withdraw`, both confirmed by executed transactions.

## Hypothesis

> Groth16 verification dominates the gas Veil pays per `shielded_transfer`. That would make the
> "~82K gas" prepare-VK overhead flagged in `verifier.move` (and proof batching after it) the
> cheapest gas win.

Falsifiable number: the share of `shielded_transfer`'s net gas that is verification computation.
**Result: falsified.** One full verify costs about 278 computation units. That is below the
1,000-unit per-transaction floor, so every user-facing entry point pays exactly the floor. Caching
the prepared VK would save **0 MIST** per transfer today. Storage is 65% of what a transfer
actually pays, and the gross cost is dominated by rewriting the shared `Pool` object.

## Threat / privacy model

Tonight was a measurement. It adds no defence. The adversaries that matter are the ones the
measurement exposed:

- **Malicious depositor (finding F1, inflation).** This is any user who can call
  `deposit_and_register`, which is permissionless. They control the 32-byte commitment they
  register and the coin they pay with, and nothing links the two. They can register a commitment
  to `Poseidon(1, B, r, s)` for any balance `B`, pay the smallest standard denomination, and later
  produce a perfectly valid withdraw proof for up to `B`. The withdraw circuit's constraint C5
  (`withdrawAmount <= cumulativeOld`) is sound, but `cumulativeOld` is attacker-chosen. The only
  on-chain bound is the pool balance, which means **other users' deposits**.
- **Colluding relayer / transaction submitter (finding F2, front-running).** This is anyone who
  sees a withdraw proof before it lands: the Veil relayer (`scripts/src/relayer.ts`) by
  construction, or anyone the user hands a signed-over payload to. The proof binds `recipientHash`,
  but `zk_withdraw` never recomputes `Poseidon(8, recipient)` from its `recipient` argument. The
  submitter simply passes their own address. They observe the proof bytes and the public inputs,
  and they need nothing else.
- **Griefer replaying proofs.** A replayed `shielded_transfer` aborts with code 9
  (`E_COMMITMENT_CHAIN_BROKEN`) only *after* the pairing check. It still costs the replayer the
  full 1,104,424 MIST, so there is no cheap-griefing asymmetry.

**What tonight does NOT address:** it fixes neither F1 nor F2; both are queued as #1. It says
nothing about gas on the live testnet/mainnet protocol version, because the public fullnode is
egress-blocked from this sandbox. Native cost tables can differ between protocol versions. It does
not measure shared-object contention on `Pool` under concurrent load (queue #4).

**Assumptions.** Localnet protocol 124 is representative of the code path's *relative* costs. The
single-party Powers of Tau generated locally tonight (`scripts/bench/setup-circuits.sh`, because
`storage.googleapis.com` is egress-blocked) does not affect any measured number: VK size, proof
size and verify gas depend on the circuit's public-input count, not on who contributed. That
ptau is not a production setup (RR2).

**STRIDE mapping.** F1 is **E4**, previously marked "Mitigated" and now **Open**. F2 is **E7**,
previously "Mitigated" and now **Open**. The "Recipient binding" control row is corrected. New
residual risks **RR0a**/**RR0b** are added to `docs/threat-model.md`. The replay measurement
supports **D3** and does not change it.

## Approach

1. **Toolchain.** The prebuilt `sui` binaries are on `github.com/.../releases`, which the proxy
   denied (403), and the public fullnode was denied too. A `git fetch` of `MystenLabs/sui` was
   allowed, so I built `sui` 1.72.1 from source at `94ad8ccd` (the Move.lock rev). That took
   33 min 19 s release on 4 cores with debuginfo off. circom 2.2.2 was also built from source.
2. **Harness: `scripts/bench/gas-localnet.ts`.** Bun + `@mysten/sui`. It publishes the package
   to a fresh `sui start` localnet and drives every user-facing entry point with real proofs. The
   pool epoch is 60 s (the contract minimum) so that timelocks and commitment maturity resolve
   inside one run. Proving shells out to `prove-cli.mjs` under Node, because snarkjs 0.7.6
   crashes under Bun with a FileHandle GC error. Every row is `effects.gasUsed`.
3. **Resolving below the floor.** Single-call PTBs all read 1,000 units. To see the real cost, I
   repeat an op k ∈ {25, 50, 100} times in one PTB, calling straight into `0x2::groth16` with no
   Veil code, and take the slope. Variants: base (`bn254()` only), prepare only, full
   prepare + verify (today's `verifier.move`), and cached (one prepare, k verifies). I
   cross-checked against the protocol config's native cost parameters.
4. **Probes.** I ran F1 and F2 as transactions that are *expected to fail* if the threat model's
   "Mitigated" claims hold. Both succeeded.

Rejected before building:
- Reading historical gas off the deployed testnet package via JSON-RPC: egress denied, and it
  wouldn't cover compliance or withdraw anyway.
- `sui move test --statistics`: it isn't real gas, because it has no storage accounting, and
  storage turned out to be the dominant term.
- Building only `sui-move`: that gives no localnet, so no real effects.

## Results

### Per-entry-point gas (protocol 124, RGP 1,000 MIST/unit, storage 7,600 MIST/byte, 99% rebate)

| Entry point | Computation | Storage cost | Rebate | **Net paid (MIST)** | Net (SUI) |
|---|---|---|---|---|---|
| `deposit_and_register` | 1,000,000 | 10,358,800 | 8,223,732 | **3,135,068** | 0.0031 |
| `shielded_transfer` | 1,000,000 | 14,485,600 | 12,610,224 | **2,875,376** | 0.0029 |
| `zk_withdraw` | 1,000,000 | 15,823,200 | 12,369,456 | **4,453,744** | 0.0045 |
| `compliant_transfer` (2 verifies) | 1,000,000 | 22,556,800 | 18,268,272 | **5,288,528** | 0.0053 |
| replayed `shielded_transfer` (abort 9) | 1,000,000 | 10,442,400 | 10,337,976 | 1,104,424 | 0.0011 |
| `create_pool` | 1,000,000 | 8,496,800 | 978,120 | 8,518,680 | 0.0085 |
| `create_compliance_config` | 1,000,000 | 18,171,600 | 11,850,300 | 7,321,300 | 0.0073 |
| `update_commitment_root` | 1,000,000 | 8,740,000 | 8,411,832 | 1,328,168 | 0.0013 |
| `propose_withdraw_vk` | 1,000,000 | 11,970,000 | 8,652,600 | 4,317,400 | 0.0043 |
| package publish | 1,380,000 | 156,415,600 | 4,890,600 | 152,905,000 | 0.1529 |

### Where the verify cost actually goes (transfer VK, 7 public inputs)

| PTB | k=25 | k=50 | k=100 | Slope 50→100 (units/op) | Protocol-config internal gas |
|---|---|---|---|---|---|
| base (`bn254()` × k) | 1,000 | 1,000 | 1,000 | ≈0 | — |
| `prepare_verifying_key` × k | 2,090 | 4,170 | 8,380 | **84.2** | `groth16_prepare_verifying_key_bn254_cost_base` = 82,010 |
| full prepare + verify × k | 6,710 | 13,500 | 27,400 | **278.0** | — |
| cached: 1 prepare, verify × k | 4,690 | 9,330 | 18,800 | **189.4** | 115,502 + 7 × 9,484 = 181,890 |

The "~82K gas" comment in `verifier.move` is accurate as *internal* gas: about 84 units, or about
84,000 MIST at RGP 1,000. It never reaches the bill, because a whole transfer (one verify plus
the Move logic) stays under the 1,000-unit floor. Even `compliant_transfer`'s two verifies
(about 556 units of groth16 work) fit under it.

**Net composition of a `shielded_transfer`:** computation 1,000,000 (34.8%) + net storage
1,875,376 (65.2%). Net storage ≈ 247 bytes of permanent state growth per transfer (one nullifier
dynamic field that is never deleted, plus the replaced commitment). Gross storage is 14.5M
because the ~1,477-byte shared `Pool` object, with both VKs inline, is rewritten on every call.
That is 99% rebated, but it is the 1% non-refundable fee and the object-size cost that scale.

### Findings (security)

| | Probe | Expected if threat model holds | Observed |
|---|---|---|---|
| **F1** | Deposit 100 TOKEN, register a commitment claiming 300; `zk_withdraw` 250 | abort | **success**: attacker's TOKEN balance 100 → 250,000,100 |
| **F2** | Withdraw proof made for Alice's `recipientHash`, submitted by Mallory with `recipient = Mallory` | abort | **success**: Mallory received the 100 |

### Determinism

Three full runs: all 26 rows common to runs 1 and 2, and all 38 rows common to runs 2 and 3,
were identical in computation, storage and rebate. That is expected: Sui gas is deterministic for
identical inputs.

### Raw output

Full log: [`raw/2026-11-18-gas-localnet-run2.log`](raw/2026-11-18-gas-localnet-run2.log). JSON:
[`raw/2026-11-18-gas-localnet-run2.json`](raw/2026-11-18-gas-localnet-run2.json).

```
$ sui --version
sui 1.72.1-94ad8ccd0ed6
$ (cd /home/user/suisrc && cargo build --release --bin sui)   # CARGO_PROFILE_RELEASE_DEBUG=0
    Finished `release` profile [optimized] target(s) in 33m 19s
$ RUST_LOG=off sui start --with-faucet --force-regenesis &
$ (cd contracts && sui move build --dump-bytecode-as-base64 --no-tree-shaking > /home/user/veil-bytecode.json)
$ cd scripts && bun run bench/gas-localnet.ts --bytecode /home/user/veil-bytecode.json --json /home/user/gas-run2.json
[info] VK bytes: transfer=488 withdraw=424 compliance=456
[info] reference gas price: 1000 MIST/unit
[info] protocol version: 124
[info] pool epoch E0=29916459; waiting for E0+1 so timelocks + commitment maturity resolve...
[info] now in pool epoch 29916460
[probe] front-run tx status=success; Mallory TOKEN balance after = 100
[probe] inflation tx status=success; Mallory TOKEN 100 -> 250000100 (deposit was 100000000)

| Entry point | Status | Computation (MIST) | Units | Storage cost | Storage rebate | Net (MIST) |
|---|---|---|---|---|---|---|
| publish (package) | ok | 1380000 | 1380 | 156415600 | 4890600 | 152905000 |
| create_pool | ok | 1000000 | 1000 | 8496800 | 978120 | 8518680 |
| token_faucet::faucet (test-only) | ok | 1000000 | 1000 | 4043200 | 2678544 | 2364656 |
| deposit_and_register (C_t) | ok | 1000000 | 1000 | 10358800 | 8223732 | 3135068 |
| deposit_and_register (C_c) | ok | 1000000 | 1000 | 10358800 | 8223732 | 3135068 |
| deposit_and_register (C_w1) | ok | 1000000 | 1000 | 10358800 | 8223732 | 3135068 |
| deposit_and_register (C_w2) | ok | 1000000 | 1000 | 10358800 | 8223732 | 3135068 |
| deposit_and_register (C_inf (probe)) | ok | 1000000 | 1000 | 10358800 | 8223732 | 3135068 |
| update_commitment_root (admin, timelocked) | ok | 1000000 | 1000 | 8740000 | 8411832 | 1328168 |
| propose_withdraw_vk (admin, timelocked) | ok | 1000000 | 1000 | 11970000 | 8652600 | 4317400 |
| create_compliance_config | ok | 1000000 | 1000 | 18171600 | 11850300 | 7321300 |
| propose_vk_update (admin) | ok | 1000000 | 1000 | 15929600 | 12091068 | 4838532 |
| cancel_vk_update (admin) | ok | 1000000 | 1000 | 12213200 | 15770304 | -2557104 |
| freeze_pool (admin) | ok | 1000000 | 1000 | 12213200 | 12091068 | 1122132 |
| unfreeze_pool (admin) | ok | 1000000 | 1000 | 12213200 | 12091068 | 1122132 |
| micro: groth16::prepare_verifying_key (transfer vk, 488 B) | ok | 1000000 | 1000 | 988000 | 978120 | 1009880 |
| micro: groth16::prepare_verifying_key (withdraw vk, 424 B) | ok | 1000000 | 1000 | 988000 | 978120 | 1009880 |
| micro: groth16::prepare_verifying_key (compliance vk, 456 B) | ok | 1000000 | 1000 | 988000 | 978120 | 1009880 |
| micro: empty PTB (groth16::bn254 only) — fixed overhead | ok | 1000000 | 1000 | 988000 | 978120 | 1009880 |
| micro: prepare_verifying_key + verify_groth16_proof (transfer, 7 inputs) | ok | 1000000 | 1000 | 988000 | 978120 | 1009880 |
| scale: base k=25 | ok | 1000000 | 1000 | 988000 | 978120 | 1009880 |
| scale: prep k=25 | ok | 2090000 | 2090 | 988000 | 978120 | 2099880 |
| scale: full k=25 | ok | 6710000 | 6710 | 988000 | 978120 | 6719880 |
| scale: cached k=25 | ok | 4690000 | 4690 | 988000 | 978120 | 4699880 |
| scale: base k=50 | ok | 1000000 | 1000 | 988000 | 978120 | 1009880 |
| scale: prep k=50 | ok | 4170000 | 4170 | 988000 | 978120 | 4179880 |
| scale: full k=50 | ok | 13500000 | 13500 | 988000 | 978120 | 13509880 |
| scale: cached k=50 | ok | 9330000 | 9330 | 988000 | 978120 | 9339880 |
| scale: base k=100 | ok | 1000000 | 1000 | 988000 | 978120 | 1009880 |
| scale: prep k=100 | ok | 8380000 | 8380 | 988000 | 978120 | 8389880 |
| scale: full k=100 | ok | 27400000 | 27400 | 988000 | 978120 | 27409880 |
| scale: cached k=100 | ok | 18800000 | 18800 | 988000 | 978120 | 18809880 |
| shielded_transfer | ok | 1000000 | 1000 | 14485600 | 12610224 | 2875376 |
| shielded_transfer replay (expected abort: commitment consumed) | failure: MoveAbort(MoveLocation { module: ModuleId { address | 1000000 | 1000 | 10442400 | 10337976 | 1104424 |
| zk_withdraw (first call — applies pending withdraw VK) | ok | 1000000 | 1000 | 15823200 | 12369456 | 4453744 |
| zk_withdraw FRONT-RUN PROBE (proof bound to Alice, recipient arg = Mallory) | ok | 1000000 | 1000 | 15823200 | 16281936 | 541264 |
| zk_withdraw INFLATION PROBE (deposited 100 TOKEN, withdraws 250 TOKEN) | ok | 1000000 | 1000 | 15823200 | 12369456 | 4453744 |
| compliant_transfer (transfer + compliance proof) | ok | 1000000 | 1000 | 22556800 | 18268272 | 5288528 |

[probe] FRONT_RUN_SUCCEEDED=true
[probe] INFLATION_SUCCEEDED=true

# replay abort detail (from the JSON):
failure: MoveAbort(MoveLocation { module: ModuleId { address: 9854cd82…, name: Identifier("pool") },
  function: 4, instruction: 134, function_name: Some("execute_transfer") }, 9) in command 0

$ curl -s -X POST localhost:9000 … sui_getProtocolConfig | (selected attributes)
storage_gas_price {'u64': '76'}
obj_data_cost_refundable {'u64': '100'}
storage_rebate_rate {'u64': '9900'}
base_tx_cost_fixed {'u64': '1000'}
gas_rounding_step {'u64': '1000'}
groth16_verify_groth16_proof_internal_bn254_cost_base {'u64': '115502'}
groth16_verify_groth16_proof_internal_bn254_cost_per_public_input {'u64': '9484'}
groth16_prepare_verifying_key_bn254_cost_base {'u64': '82010'}

# determinism check across the three runs (python over the three --json outputs)
run1 vs run2: common=26 differing=[]
run2 vs run3: common=38 differing=[]
```

The full test suite was run tonight before the PR:

```
$ cd contracts && sui move test
Test result: OK. Total tests: 124; passed: 124; failed: 0
$ cd circuits && npm test          # Mode: FULL PROOF (snarkjs Groth16), all three files, EXIT 0
=== Results: 43 passed, 0 failed ===
=== Results: 30 passed, 0 failed ===
=== Results: 35 passed, 0 failed ===
$ cd scripts && bun run src/test-converter.ts && bun run src/test-compliance-utils.ts && bun run src/fuzz-tests.ts
ALL 6 PROPERTIES PASSED            # EXIT 0
$ cd frontend && bunx tsc --noEmit && bunx biome check . && bunx vitest run
 Test Files  3 passed (3)
      Tests  19 passed (19)
```

Circuits recompiled tonight match the 2026-07-22 baseline exactly. Transfer: 6,470 non-linear +
7,141 linear. Withdraw: 1,465 + 1,593. Compliance: 6,057 + 6,686.

Note: the suites are green *and* F1/F2 exist. Neither the Move tests nor the circuit tests
exercise the deposit→withdraw value flow or the proof↔`recipient` argument binding end-to-end.
That is a coverage gap, not a passing claim.

## Verdict

**KEEP.** The measurement, the harness and the `BASELINE.md` gas section are merged. The embedded
optimisation hypothesis is **refuted**: Groth16 verification is about 28% of the computation
floor, and caching the PVK saves nothing per transfer at protocol 124. That knowledge survives in
the re-ranked queue. The two findings move straight to the top of the queue.

## Where this could be used

- **Any Groth16-on-Sui app** (zkLogin-adjacent credential checks, private voting, Semaphore-style
  group membership). One `verify_groth16_proof` at ≤ about 10 public inputs is below the 1,000-unit
  floor. Engineering effort belongs in object layout and storage, not in shaving pairing work.
  The k-slope PTB technique is reusable for costing any sub-floor native on Sui.
- **Privacy pools with a single shared pool object** (Tornado-style mixers ported to Sui). Inline
  VKs on the hot shared object cost about 1.2M MIST gross per call. Moving them to a separate
  immutable object, which is read-only and rewrite-free, is a pure storage win.
- **Thesis chapter on "verifier-side cost models across chains".** On EVM, a Groth16 verify
  (about 200–250k gas; a commonly cited figure, not measured here) dominates a mixer withdrawal. On Sui protocol 124 it is under the
  per-transaction floor and storage dominates. That inversion is the chapter's core data point.
- **F1/F2 as a case study** for "spec says Mitigated, chain says otherwise": circuit-level
  bindings that the on-chain verifier never checks. This applies to any protocol that splits
  proof statements between circuit and contract (shielded withdrawals, bridge claim proofs,
  payroll disbursements to a recipient committed in-circuit).

## Open questions (→ queue)

1. **Fix F1 + F2** with a soundness argument, a leakage analysis and negative tests (the two
   probes become Move/e2e regression tests).
   - F2: `zk_withdraw` recomputes `sui::poseidon::poseidon_bn254` over `[8, recipient_field]`.
     The address→field mapping must be fixed and documented, because a Sui address is 256 bits
     and exceeds BN254 r. Its gas cost is the measurable number.
   - F1: bind value at deposit, either with a deposit proof or by storing the amount with the
     commitment. Check whether the same gap lets `shielded_transfer` inflate `cumulative`.
2. How much does batching N transfers into one relayer PTB save? The computation floor amortizes
   (about 1,000 → about 300 units per transfer is plausible), but storage, 65% of net, does not.
   This needs measuring, together with what one PTB of N transfers leaks: it links them to the
   same relayer submission.
3. Moving the VKs out of the shared `Pool` into an immutable object: what is the measured
   gross-storage delta per transfer?
4. Gas on the live testnet protocol version (needs fullnode egress).
5. Nullifier dynamic fields grow without bound, at about 247 bytes per transfer. What is the
   storage bill at 10^6 transfers, and is a nullifier accumulator cheaper?
