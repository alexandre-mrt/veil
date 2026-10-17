# 2026-10-17 — On-chain gas per entry point (queue item #1)

## Hypothesis

Groth16 verification accounts for the majority of the on-chain gas of `shielded_transfer`,
`compliant_transfer` and `zk_withdraw`, so cutting verification work (prepared-VK storage, proof
aggregation) is the lever that moves Veil's per-transfer gas. This experiment measures every
entry point with real proofs on a real Sui network binary to find out whether that is true.
**It is not** — see Verdict. (Item #1 had been BLOCKED on the toolchain twice; tonight it was
unblocked first, then measured.)

## Threat / privacy model

No protocol change, so no new adversary. The adversaries that gas numbers matter to:

- **Griefing / DoS adversary** — spams `shielded_transfer` with invalid proofs against the shared
  `Pool` object. What they pay per attempt is now measured (below): ~1.11M MIST net, of which the
  computation charge is the 1,000-unit floor. What they observe: nothing secret; the Pool is a
  public shared object. Residual: contention on the single shared `Pool` is **not** measured here
  (no concurrency load was applied) — a rejected transaction still sequences through consensus.
- **Colluding / malicious relayer** — any party who sees `(proof, public_inputs)` before inclusion.
  This is where the night turned up a real finding (see "Finding" below): a relayer can redirect
  a `zk_withdraw` to its own address.
- Not defended / out of scope: chain-observer linkability (unchanged), trusted-setup trust (the
  circuits were set up with a throwaway local ptau and one dev contribution — fine for gas, which
  does not depend on setup provenance; see `docs/threat-model.md` RR2), post-quantum.

Assumptions: the local network runs the same Move VM / Groth16 natives and protocol config as
the pinned framework (`sui` 1.72.1, same commit as `contracts/Move.toml`'s `rev`). Mainnet differs
in reference gas price (localnet RGP = 1000 MIST/unit) and validator tips; computation *units* and
storage bytes transfer, absolute MIST computation cost scales with RGP.

STRIDE mapping: **E (Elevation)** E7 in `docs/threat-model.md` (front-run withdrawal) — claimed
Mitigated, measured NOT mitigated on-chain; row updated. **D (DoS)**: first real number for the
per-attempt cost of invalid-proof spam.

## Approach

1. Unblock the toolchain (the previous run's blocker). A prebuilt CLI *is* reachable from this
   sandbox: GitHub release assets for `MystenLabs/sui` download fine (the REST API and the public
   fullnodes do not). `Move.toml` pins a framework commit that is 1.72.1, so the matching
   `testnet-v1.72.1` binary was used (1.50.1 first, rejected: cannot compile the pinned framework).
2. `sui move test` → 124/124 pass (closes the "NOT RUN" row).
3. Build the circuits (`circom` v2.2.2 from source; pot15 is unreachable from here —
   `storage.googleapis.com` 403 — so a local 2^15 ptau was generated with snarkjs; constraint
   counts match the 2026-07-22 baseline exactly: 13,611 / 12,743 / 3,058).
4. `scripts/bench/gas.mjs`: boots against `sui start --force-regenesis`, publishes the real
   package, creates a pool, deposits three notes, proposes the commitment root / withdraw VK,
   creates a compliance config, waits one 60 s epoch for the timelocks, then submits **real
   Groth16 proofs** for each entry point. Reads `effects.gasUsed` from every transaction.
5. Marginal-cost sweep: N copies of `0x2::groth16::verify_groth16_proof` in one PTB (framework
   only, no Veil code), both re-preparing the VK each time (what `verifier.move` does) and
   preparing it once. The slope of computation units vs N isolates the verify and prepare costs.

Rejected before building: reading gas from `sui move test` output (that is VM instruction count,
not the charged gas schedule and not storage); estimating from the Sui gas schedule by hand
(an estimate, which the loop forbids); public-fullnode historical reads (blocked by the sandbox
network policy — and would be mixed-version data anyway).

## Results

All numbers MIST unless marked units. Computation unit = 1000 MIST at RGP 1000. Net = computation +
storage − rebate. Raw per-transaction records: `scripts/bench/gas-results.json`; full console
output: [`2026-10-17-gas-per-entry-point.raw.log`](2026-10-17-gas-per-entry-point.raw.log).

### Per entry point (single run; three identical `deposit_and_register` calls returned byte-identical gas, so these are deterministic)

| Entry point | Computation (units) | Storage | Rebate | Net |
|---|---|---|---|---|
| `publish` (6 modules) | 1,380 | 156,415,600 | 4,890,600 | 152,905,000 |
| `pool::create_pool` | 1,000 | 8,496,800 | 978,120 | 8,518,680 |
| `token_faucet::faucet` | 1,000 | 4,043,200 | 2,678,544 | 2,364,656 |
| `pool::deposit_and_register` (+ `splitCoins`) | 1,000 | 10,358,800 | 8,223,732 | 3,135,068 |
| `pool::update_commitment_root` (propose) | 1,000 | 8,740,000 | 8,411,832 | 1,328,168 |
| `pool::propose_withdraw_vk` (propose) | 1,000 | 11,970,000 | 8,652,600 | 4,317,400 |
| `compliance::create_compliance_config` | 1,000 | 18,171,600 | 11,850,300 | 7,321,300 |
| **`pool::shielded_transfer`** (1 Groth16 verify, 7 inputs) | **1,000** | 14,485,600 | 12,610,224 | **2,875,376** |
| **`compliance::compliant_transfer`** (2 verifies) | **1,000** | 22,556,800 | 18,268,272 | **5,288,528** |
| **`pool::zk_withdraw`** (1 verify, 5 inputs) | **1,000** | 15,823,200 | 12,369,456 | **4,453,744** |
| `pool::freeze_pool` | 1,000 | 11,970,000 | 11,850,300 | 1,119,700 |
| `shielded_transfer`, **rejected** proof (aborts `E_INVALID_PROOF`) | 1,000 | 10,685,600 | 10,578,744 | 1,106,856 |

**Every Veil entry point — including the two-proof `compliant_transfer` — sits exactly on Sui's
1,000-unit minimum computation bucket.** The proof-verification work is below the floor and
invisible in the bill.

### Marginal Groth16 cost (framework calls only, one PTB, N verifies of the same proof)

| N | transfer VK, re-prepare each (units) | transfer VK, prepare once | withdraw VK, re-prepare each | withdraw VK, prepare once |
|---|---|---|---|---|
| 1 | 1,000 | 1,000 | 1,000 | 1,000 |
| 4 | 1,070 | 1,000 | 1,000 | 1,000 |
| 8 | 2,140 | 1,550 | 1,990 | 1,400 |
| 16 | 4,290 | 3,020 | 3,980 | 2,720 |
| 32 | 8,610 | 5,970 | 7,990 | 5,360 |
| 64 | 17,400 | 12,000 | 16,200 | 10,700 |

Slopes from N=32→64: transfer **≈275 units per prepare+verify**, **≈188 per verify** → `prepare_verifying_key`
≈ **86 units**; withdraw ≈257 / ≈167 → prepare ≈ 90 units. Per-verify cost grows with public inputs
at ≈ 10.7 units/input (7-input vs 5-input, prepare-once slope). Consequence: a verify costs about
27% of the 1,000-unit floor; ~3 verifies (re-prepared) or ~5 (prepared once) fit under it.
The `verifier.move` comment ("~82K gas" saving from a stored PreparedVerifyingKey) checks out
(86 units ≈ 86,000 MIST) but is worth **0 MIST today**, because a single verify never leaves the floor.

Other results from the same run:

| Check | Result |
|---|---|
| `sui move test` (pinned framework, sui 1.72.1) | `Total tests: 124; passed: 124; failed: 0` |
| `circuits` `npm test` | 43 + 30 + 35 passed, 0 failed |
| `scripts` `bun run test` (converter) | 109 passed, 0 failed |
| Circuit constraints (rebuilt) | 13,611 / 12,743 / 3,058 — identical to 2026-07-22 |

(Frontend tests not run: nothing in `frontend/` changed.)

### Reproduce

```
bash scripts/bench/build-circuits.sh                 # needs circom on PATH, PTAU=<pot15_final.ptau>
sui start --force-regenesis --with-faucet &          # sui 1.72.1 (testnet-v1.72.1 release binary)
cd scripts/bench && npm install && node gas.mjs      # ~3 min incl. one 60 s epoch wait
(cd contracts && sui move test)
```

## Finding (not the experiment, but a broken invariant): `zk_withdraw` does not bind `recipient`

`docs/threat-model.md` E7 says changing the recipient "invalidates the Groth16 proof". It does not.
`pool::zk_withdraw` verifies the proof against `public_inputs_bytes` (which contain
`recipientHash = Poseidon(8, recipient)`), but then pays out to the separate `recipient: address`
argument **without ever checking that the argument hashes to `recipientHash`** — the proof binds a
hash, the transaction supplies an address, nothing connects them.

Measured, not argued: `gas.mjs` proves a withdrawal whose `recipientHash` commits to address *X*,
then submits `zk_withdraw(..., recipient = Y)` for an unrelated fresh address *Y*:

```
pool::zk_withdraw (recipient != proven one)  success  comp=1000000 (1000 units) storage=15823200 rebate=12369456 net=4453744
  -> unrelated address 0xe58346a52ce85461e459d21cdcd25bca1650840ee83d2a6392b59d40f2e4deba received 100 TOKEN units; tx status success
```

Impact: anyone who sees a withdrawal's `(proof, public_inputs)` before it is included — a relayer,
an RPC provider, any observer of a not-yet-finalised transaction — can resubmit it with their own
address and take the funds; the user's nullifier is then spent. Severity is bounded by how often
that exposure exists (Sui has no public mempool, but a relayer-submitted withdrawal is exactly
this exposure). Fix sketch, **not implemented tonight** (it is a contract+circuit-interface change
and needs its own soundness/negative-test PR): recompute the hash on-chain with
`sui::poseidon::poseidon_bn254` over a field-safe encoding of `recipient` and compare to bytes
96..128. Subtlety: a 256-bit Sui address can exceed the BN254 scalar field, so the circuit's
`recipient` signal and the on-chain encoding must agree (split into two limbs or reduce mod r and
reject non-canonical addresses). A Move negative test (`zk_withdraw` with a mismatched address must
abort) should be added with the fix. Added to the queue as #1.

Also from reading the code (**not empirically tested**, so unverified): `compliant_transfer` does
not appear to compare the compliance proof's `contextId` (bytes 64..96) to the transfer proof's
nullifier, and `encrypted_amount` is only length-checked, so the compliance proof and the
auditor ciphertext may not be bound to the transfer they accompany. Queued for the soundness audit.

## Verdict

**KEEP** — gas baseline merged into `BASELINE.md`; item #1 closed; the Move test suite is now
verified (124/124).

The *hypothesis is falsified*: verification is not the majority of the gas; it is below the floor.
Where the money goes: the bill is **storage**, not computation. For `shielded_transfer`, 1.0M of the
2.88M MIST net is the computation floor and the remaining ~1.9M is storage written (new dynamic
fields for the nullifier and the new commitment, plus rewriting the whole `Pool` object — which
carries ~4 KB of VK bytes — on every call; the rebate recovers most of the gross storage charge).
Consequences for the queue: aggregating/batching proofs to save *verification gas* has no payoff
until a transaction carries more than ~3–5 verifies (item re-ranked down); the lever that exists
today is **packing several transfers into one PTB** to amortise the 1,000-unit floor and the
per-tx overhead, and moving VKs out of the hot `Pool` object so it stops being rewritten whole.
Both are UNMEASURED extrapolations from the sweep above, not results.

Limits: single local network, RGP 1000, no tip, no concurrency; storage price per byte is the
localnet protocol-config default and should be re-checked against the target network. A ptau
generated locally was used, which affects nothing measured here.

## Where this could be used

- **Any Groth16-on-Sui application** (zk-login-style credential checks, private voting, shielded
  payments): the sweep gives a reusable cost model — ≈188 units/verify + ≈10.7 units/public input +
  ≈86 units/`prepare_verifying_key`, floor 1,000 units — so a design that fits 3–5 verifies per
  PTB pays one computation floor. `gas.mjs` can be pointed at any package.
- **Confidential payroll on Sui with a t-of-n auditor board**: a payroll run of K payouts is K
  `zk_withdraw`/`compliant_transfer` calls; the PTB-packing result decides whether it is K×1,000 or
  ceil(K/3)×1,000 computation units.
- **Thesis chapters**: "Cost model of pairing-based verification on Move" (this sweep) and
  "Binding public statements to transaction parameters" (the recipient finding — a class of bug
  where a proof commits to a hash and the surrounding transaction supplies the preimage).
- **Relayer design**: the rejected-proof price (~1.1M MIST) is the per-attempt griefing cost to
  size relayer rate limits against.

## Open questions (tomorrow's queue)

1. Fix and test the `zk_withdraw` recipient binding (security, outranks everything else).
2. Measure k `shielded_transfer` calls in one PTB (k = 1..8): where does computation leave the
   floor, and does the shared `Pool` object serialise them?
3. Measure moving `transfer_vk`/`withdraw_vk` out of `Pool` (separate shared/immutable object or
   PVK-in-object): does net storage per transfer drop by the VK size?
4. Verify (empirically) whether `compliant_transfer` binds `contextId` / `encrypted_amount` to the
   transfer — negative tests.
5. Concurrency: N parallel transfers against one Pool on the local network — throughput and abort
   rate (needs a multi-validator or at least multi-client load harness).
6. Re-run on testnet once a fullnode is reachable, to replace the localnet RGP/storage-price
   assumptions with the real ones.
