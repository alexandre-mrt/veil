# 2026-10-04 — On-chain gas baseline (queue item #1)

## Hypothesis

Every Veil entry point's on-chain gas can be measured with real Groth16 proofs, and the measurement
will show whether Groth16 verification (the thing queue item #3 — proof aggregation — would remove)
is actually where a transfer's cost lives. Falsifiable claim: *"a `shielded_transfer`'s computation
charge is dominated by the Groth16 check."* It moves "entry points with a measured gas number" from
0 to 12 and decides whether item #3 stays on the queue.

**Result: the claim is false.** One full verify is ~267 compute units; Sui bills a 1,000-unit
minimum per transaction, so every proof-carrying entry point sits on that floor, and the
cost that is *not* the floor is storage.

## Threat / privacy model

A measurement night — no circuit or Move change — so there is no new defence. Two things matter:

- **Who relies on the numbers:** later experiments (aggregation, Poseidon2, batch insertion) are
  diffs against this table; a guessed baseline would silently corrupt them. A gas-griefing analysis
  (how cheap is it for an attacker to make the pool pay for work, or to bloat state?) needs real
  per-op cost first.
- **A finding that came out of the run (security, not performance):** while driving `zk_withdraw`
  with real proofs I observed that the recipient is not bound on-chain — see *Finding F1* below. The
  adversary is a **colluding/malicious relayer or any party who sees a withdrawal tx before it is
  ordered** (a validator, a relayer holding the proof): they can resubmit the same proof with their
  own `recipient` address and take the funds. A chain observer who only sees finalized txs learns
  nothing new from this.

What this does **not** establish: gas on testnet/mainnet in SUI (prices differ, see Assumptions),
anything about contention under concurrency, or soundness of the circuits.

Assumptions: localnet runs the same protocol config / gas schedule as the CLI release used
(`sui 1.72.1`, matches the `Move.toml` framework pin `94ad8cc` = `sui_v1.72.1`); gas *units* and
storage *bytes* are deterministic for identical bytecode+inputs, prices are not. Trusted setup: a
**locally generated** pot15 (the Hermez ptau hosts are unreachable from this sandbox — HTTP 403) and
a single dev contribution; irrelevant to gas (proof = 128 B, VK sizes fixed by circuit shape) but it
means these zkeys are *not* the 2026-07-22 ones. STRIDE: finding F1 contradicts `docs/threat-model.md`
**E7** (Elevation of Privilege / front-running) — updated in this PR.

## Approach

Built `scripts/bench/gas.ts` (run: `node --experimental-strip-types gas.ts`; Bun crashes inside
snarkjs' worker threads, so Node is required). It starts from a clean `sui start --force-regenesis
--with-faucet` network, publishes `contracts/` via the SDK (`--no-tree-shaking` offline build), then:

1. creates a pool (120 s epochs so timelocks/maturity are exercisable), deposits 13 commitments,
   proposes the commitment root and withdraw VK, creates a compliance config;
2. pre-generates **real** transfer / compliance / withdraw proofs for epoch E+1 against a real
   depth-20 Merkle root, waits for E+1, then submits them;
3. records `effects.gasUsed` for each tx, repeating (n=3) where possible;
4. **verification floor:** a valid proof aborted *immediately after* the Groth16 check
   (`E_MERKLE_ROOT_MISMATCH` / `E_COMMITMENT_CHAIN_BROKEN`) — Sui charges computation up to the abort;
5. **scaling harness:** a throwaway `bench_verify` module compiled into a *copy* of the package (the
   verifier functions are `public(package)`) that runs the verify `n` times in one tx — computation is
   linear above the floor, so the slope is the true per-verify cost.
6. **PTB batching:** 4 `shielded_transfer` calls in one transaction.

Witness builders (`witnesses.mjs`) gained optional overrides (epoch, user, Merkle path); defaults are
unchanged so the 2026-07-22 harnesses are unaffected.

Rejected: reading historical gas from testnet fullnode (egress blocked: `Host not in allowlist`);
building `sui` from source (a prebuilt release binary was reachable on GitHub Releases —
`testnet-v1.72.1`; v1.60 was tried first and failed to compile the pinned framework, so the CLI must
match the `Move.toml` rev); `sui move test --statistics` (mocked proofs, doesn't price real txs).

## Results

Machine: 4 vCPU Xeon @ 2.8 GHz, localnet, RGP = 1000 MIST/unit. Net = computation + storage − rebate
(MIST; 1 SUI = 10⁹ MIST). Full raw output: `data/2026-10-04-gas-raw.txt` / `.json`.

| Entry point | Computation (units) | Storage cost | Storage rebate | **Net (MIST)** | n |
|---|---|---|---|---|---|
| `deposit_and_register` | 1,000 (floor) | 9,021,200 | 8,223,732 | **1,797,468** | 13 |
| `shielded_transfer` | 1,000 (floor) | 14,485,600 | 12,449,712 | **3,035,888** | 3 |
| `compliant_transfer` (2 proofs) | 1,000 (floor) | 22,556,800 | 18,268,272 | **5,288,528** | 3 |
| `zk_withdraw` | 1,000 (floor) | 15,823,200 | 12,369,456 | **4,453,744** | 3 |
| `shielded_transfer` ×4 in **one PTB** | 1,510 | 26,615,200 | 18,463,896 | **9,661,304** (2.42 M/transfer) | 1 |
| `create_pool` (4,025 B VK) | 1,000 | 8,496,800 | 978,120 | 8,518,680 | 1 |
| `create_compliance_config` | 1,000 | 18,171,600 | 11,850,300 | 7,321,300 | 1 |
| `propose_withdraw_vk` | 1,000 | 11,970,000 | 8,652,600 | 4,317,400 | 1 |
| `update_commitment_root` (propose) | 1,000 | 8,740,000 | 8,411,832 | 1,328,168 | 1 |
| `propose_withdrawal` / `cancel_withdrawal` | 1,000 | 12,274,000 / 11,970,000 | 11,850,300 / 12,151,260 | 1,423,700 / 818,740 | 1 |
| `freeze_pool` / `unfreeze_pool` | 1,000 | 11,970,000 | 11,850,300 | 1,119,700 | 1 |
| publish (package, once) | 1,390 | 156,415,600 | 9,781,200 | 148,024,400 | 1 |

Verification cost — slope between n=16 and n=64 verifies in one tx (computation is linear above the
1,000 floor; table in raw file):

| Operation | Units per call | Derivation |
|---|---|---|
| `prepare_verifying_key` + `verify` (what `verifier.move` does per proof) | **≈267** | (17,400 − 4,570) / 48 |
| `prepare_verifying_key` alone | **≈83** | (5,620 − 1,640) / 48 |
| `verify` with a prepared VK | **≈185** | (12,200 − 3,330) / 48 (267 − 83 = 184 ✓) |

Aborted-right-after-verify txs (floor test): `shielded_transfer` and `zk_withdraw` both charged exactly
1,000 units, i.e. verify + surrounding logic never leaves the floor on its own.

Derived (from the rows above): 4 transfers cost 1,510 units in one tx vs 4 × 1,000 separately → **62% less computation, 20%
less net cost** (9.66 M vs 12.14 M MIST) with **no protocol change**.

Move suite on the same toolchain: `Test result: OK. Total tests: 124; passed: 124; failed: 0`.

Raw highlights (verbatim):
```
shielded_transfer | 3 | ok | 1000 | 1000000 | 14485600 | 12449712 | 3035888
shielded_transfer x4 in ONE PTB | 1 | ok | 1510 | 1510000 | 26615200 | 18463896 | 9661304
scale: prepare_vk+verify (transfer) x n=16 | 1 | ok | 4570 | 4570000 | 988000 | 978120 | 4579880
scale: prepare_vk+verify (transfer) x n=64 | 1 | ok | 17400 | 17400000 | 988000 | 978120 | 17409880
scale: prepare_vk only (transfer VK) x n=64 | 1 | ok | 5620 | 5620000 | 988000 | 978120 | 5629880
PROBE recipient-binding: proofs commit to recipient field 0xABCDEF123456; unrelated address 0x6a443aed1ab0fe7a832097b60664667226ecce2e41e307cb746ce6f54e295f7d received 300 base units from 3 zk_withdraw txs
```

### What the numbers mean

- Computation is **not** the cost driver: 1.0 M of a 3.04 M-MIST transfer is the *per-tx minimum*,
  and the proof check is ~27% of even that. The other ~2.0 M is net **storage growth** (nullifier +
  new commitment dynamic fields, one old commitment freed) — permanent state.
- Gross storage (14.5 M) is mostly the shared `Pool` object being rewritten (it embeds both VKs,
  ~8 KB), but ~99% of that is rebated, so moving VKs out of `Pool` would save only the 1%
  non-refundable fee. Not worth pursuing.
- The `verifier.move` note "prepare VK each call costs ~82K gas" is **confirmed** (≈83 units × 1000 =
  83K MIST), but it is 83 units *inside a 1,000-unit floor* — storing a prepared VK would not change
  a single-transfer bill.

## Finding F1 — `zk_withdraw` does not bind `recipient` on-chain (security)

`pool.move:zk_withdraw` takes `recipient: address` as a free argument and never relates it to the
proof's `recipientHash` (Move cannot compute Poseidon; the comment at `pool.move:595-599` asserts the
proof "verifies" the binding, but the proof only commits to a field element — the contract never
checks the address matches it). The bench demonstrates it: proofs committed to recipient field
`0xABCDEF123456`, three txs sent funds to an unrelated fresh address and all succeeded
(`PROBE` line above). Consequence: whoever holds `(proof, public inputs)` before ordering — a
relayer, or an MEV-style validator — can redirect the withdrawal. `threat-model.md` E7 ("Mitigated")
is therefore inaccurate; I changed it to **Open** and did not fix the contract tonight (a fix needs
a design decision: e.g. make the circuit's recipient the address itself split into 2×128-bit limbs and
pass those as public inputs the contract recomputes from `recipient` bytes — no on-chain hash needed).

## Verdict

**KEEP.** BASELINE.md updated: gas row closed, Move suite row closed. Queue re-ranked: aggregation
(#3) drops below storage/state work; new top item is fixing F1. Honest limits: n=3 samples (gas is
deterministic — all three matched exactly), localnet prices, locally generated ptau (non-comparable
zkey bytes vs 2026-07-22), compute under the floor cannot be resolved per entry point, only bounded.

## Where this could be used

- **Cost model for any Sui ZK pool** (private payroll, shielded stablecoin rails, ZK voting): the
  finding that a Groth16 check is ~270 units against a 1,000-unit floor generalises — on Sui, minimise
  *state written per tx*, not verifier cost. Chapter: "Cost model for on-chain verification on object-
  centric chains".
- **PTB batching as a relayer feature**: a relayer that packs k transfers per PTB (the `scripts/src/
  relayer.ts` path) gets −62% computation today; also a metadata question (batching links senders to
  one relayer tx) — thesis section on relayer leakage.
- **F1 pattern** applies to any Sui protocol that passes an address next to a proof: bind it via
  public-input limbs, never via an off-chain-only hash. Directly relevant to a "confidential payroll
  with a t-of-n auditor board" payout path.

## Open questions (→ queue)

1. Fix F1 (recipient limbs as public inputs) + a negative test; re-measure `zk_withdraw` (7 inputs vs 5).
2. Net storage per transfer ≈ 2.0 M MIST is permanent state: can nullifiers be committed to an
   accumulator (one object) instead of one dynamic field each? Measure per-N growth.
3. Where does a PTB of k transfers leave the floor-dominated regime, and what does shared-object
   contention do to k concurrent PTBs (never measured)?
4. Re-run gas on testnet once an egress allowlist includes `fullnode.testnet.sui.io`, to price in SUI.
