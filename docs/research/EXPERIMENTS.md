# Veil — Experiment Queue

Ranked. The nightly loop takes the highest-ranked item that is not already `KEEP` or `REJECT` in
`LEDGER.md`. Re-rank at the end of every night.

Each entry: a falsifiable hypothesis, the metric it moves, and the adversary it concerns.

---

## 1. `baseline` — measure what Veil actually costs today
**Hypothesis:** Veil's real cost profile is unknown and at least one number will be a surprise.
**Metric:** everything — per-circuit constraints, witness-gen and proving time, VK/proof size,
on-chain gas for `deposit_and_register` / `shielded_transfer` / `withdraw`, Merkle insert cost,
browser proving latency (cold + warm).
**Why first:** every other experiment is a comparison, and there is nothing to compare against.
Blocks #2, #3, #6. Output: `BASELINE.md`, plus a reusable `scripts/bench/`.

## 2. `bulletproofs-vs-groth16` — head-to-head, same machine
**Hypothesis:** Bulletproofs (no trusted setup) cost more to verify on-chain but less to set up and
maintain than Veil's Groth16 + VK-timelock machinery; the crossover point is measurable.
**Metric:** proving time, verify gas, proof size, and the governance surface each removes.
**Adversary:** none directly — this is a cost/assumption trade, not a security one. What it buys is
the removal of a **trusted-setup assumption**.
**Depends on:** #1. Contra's side is already measured (2026-07-14).

## 3. `contra-hybrid-settlement` — the interesting half of contra
**Hypothesis:** Veil's shielded pool (sender-anonymous) can settle its *withdrawal leg* into a
contra-style Ristretto/Bulletproofs confidential balance, giving amount privacy on exit — where the
recipient is already public — **without a trusted setup** and without touching the anonymity set.
**Metric:** gas + latency of the exit path; whether the anonymity set is preserved (it must be).
**Adversary:** the chain observer watching withdrawals, who today sees the exit amount.
**Depends on:** #1. Context: `2026-07-14-contra-confidential-transfers.md`.

## 4. `auditor-model-comparison` — escrow vs selective disclosure
**Hypothesis:** contra's per-account viewing-key escrow can be narrowed to *per-transaction*
disclosure using the DDH decryption proof its SDK already exposes (`decryptWithProof`) — closing the
gap with Veil's proof-based model without giving up its cheap transfers.
**Metric:** what exactly the auditor learns, formally, under each model.
**Adversary:** **a malicious or compromised auditor.** This is the one Veil claims to defend against
and contra does not. Highest thesis value of anything in this queue.

## 5. `poseidon2` — cheaper hashing
**Hypothesis:** swapping Poseidon for Poseidon2 cuts constraints in the transfer and compliance
circuits, and therefore proving time, with no change to the security argument.
**Metric:** constraint count per circuit → proving time.
**Care:** all 8 domain tags must survive the swap without collision; needs a negative test.

## 6. `merkle-scale` — does the accumulator hold at 10⁵–10⁷ commitments?
**Hypothesis:** the depth-20 Poseidon tree and its off-chain indexer degrade before the anonymity
set gets interesting.
**Metric:** insert throughput, root-update latency, proof-gen time vs tree occupancy.
**Adversary:** the statistical deanonymiser — a small anonymity set is the attack.
**Also:** measure shared-object contention on the pool under concurrent transfers
(`ExecutionCancelledDueToSharedObjectCongestion`), which caps real throughput regardless of the tree.

---

## Research track: arkworks (Rust proving stack)

Veil proves with Circom/snarkjs today. arkworks is the path to things Circom cannot do. See the
`veil-arkworks` skill.

## 7. `recursion-spike` — one proof for many transfers  ← NOW UNBLOCKED, top of the arkworks track
**Hypothesis:** folding (Nova) or recursive Groth16 lets N transfers be verified on-chain as ONE
proof, turning per-transfer verify gas into amortised gas.
**Metric:** on-chain verify gas per transfer at N = 1, 10, 100.
**Adversary:** none — pure scalability. This is the single largest lever in the queue if it works.
**Risk:** high. Time-box it; a negative result is a real result.
**Unblocked 2026-07-14:** #8 proved an arkworks proof of the exact transfer relation verifies under
`sui::groth16` with Circom-identical hashing — recursion now has a verified base to build on.

## 8. `arkworks-prover-parity` — can arkworks reproduce the transfer circuit?  ✅ DONE 2026-07-14 (KEEP)
**Result:** YES on the claim that matters — the arkworks Groth16 proof verifies on-chain under
`sui::groth16` (Move test, sui 1.75.0), and Poseidon hashing is byte-identical to circomlib, so **no
commitment-tree re-hash is needed**. The naive "identical VK" framing was wrong and is corrected in
the report: switching provers changes the VK (needs a timelock roll), but the *relation and hashes*
are identical. 6 334 constraints (vs snarkjs --O2 6 384), 89 ms prove. See
`2026-07-14-arkworks-prover-parity.md`. Follow-up work is #7.

---

## Research track: TEE (credential issuance)

No TEE code exists in Veil today. This is the master-thesis direction (ZKP + TEE anonymous
credentials). See the `veil-tee-issuance` skill.

## 9. `tee-issuance-spike` — KYC credential issued inside an enclave  ⏸ PARK 2026-07-14 (blocked on AWS)
**Result:** everything provable off Nitro hardware works — the credential leaf matches Veil's exact
`Poseidon(4, userSecret, kycLevel, expiryEpoch, issuerId)`, the Rust↔Move BCS signature parity is
proven (6 Move + 10 Rust tests), statelessness is structural. The review caught and fixed a
generic-`<T>` authorization bypass (a self-registered enclave could forge issuance) by binding to the
concrete `Enclave<VEIL_TEE>` type. **Blocker to KEEP:** the attestation root (real Nitro doc + PCRs +
`sui::nitro_attestation`) is unprovable without an EC2 Nitro instance. See
`2026-07-14-tee-credential-issuance.md`.
**To unpark:** get an EC2 Nitro instance, produce the attestation, pin real PCRs, prove
`register_enclave` on-chain.

## 10. `tee-vs-zk-revocation` — revocation without a trusted issuer
**Hypothesis:** enclave-attested revocation lists beat accumulator-based revocation (RSA/KZG) on
cost, at the price of a hardware trust assumption. Quantify both sides before choosing.
**Metric:** revocation-check cost in-circuit; size of the trust base.
