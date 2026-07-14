# Veil — Experiment Queue

Ranked. The nightly loop takes the highest-ranked item that is not already `KEEP` or `REJECT` in
`LEDGER.md`. Re-rank at the end of every night.

Each entry: a falsifiable hypothesis, the metric it moves, and the adversary it concerns.

---

## 1. `fix-stale-transfer-artifacts` — close the gap `baseline` found
**Hypothesis:** `transfer.circom`'s test witness builder and the frontend's committed VK predate the
circuit's Merkle anonymity-set proof (7 public inputs, not 6) — fixing both is small, well-scoped, and
currently blocks the frontend from producing any proof the on-chain verifier accepts.
**Metric:** `circuits/test/transfer.test.mjs` passes 40/40 for real (not vacuously); a freshly
regenerated `frontend/public/circuits/transfer_{wasm,zkey,vk.json}` matches current `main`'s
`transfer.circom`; `CLAUDE.md`/`docs/SPEC.md` no longer claim 11 constraints / 6 public inputs.
**Not a research question** — this is a bug found by measurement, ranked first because it's cheap and
currently broken, not because it's interesting.
**Context:** `2026-07-14-baseline.md`.

## 2. `bulletproofs-vs-groth16` — head-to-head, same machine
**Hypothesis:** Bulletproofs (no trusted setup) cost more to verify on-chain but less to set up and
maintain than Veil's Groth16 + VK-timelock machinery; the crossover point is measurable.
**Metric:** proving time, verify gas, proof size, and the governance surface each removes.
**Adversary:** none directly — this is a cost/assumption trade, not a security one. What it buys is
the removal of a **trusted-setup assumption**.
**Status:** Veil's proving-time/proof-size side is now measured (`BASELINE.md`); on-chain gas is
still `BLOCKED` on `sui` CLI access (see `2026-07-14-baseline.md`) — do the gas half before calling
this settled. Contra's side is already measured (2026-07-14).

## 3. `contra-hybrid-settlement` — the interesting half of contra
**Hypothesis:** Veil's shielded pool (sender-anonymous) can settle its *withdrawal leg* into a
contra-style Ristretto/Bulletproofs confidential balance, giving amount privacy on exit — where the
recipient is already public — **without a trusted setup** and without touching the anonymity set.
**Metric:** gas + latency of the exit path; whether the anonymity set is preserved (it must be).
**Adversary:** the chain observer watching withdrawals, who today sees the exit amount.
**Context:** `2026-07-14-contra-confidential-transfers.md`.

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
**Status:** baseline to beat is now measured — `transfer.circom` 13,611 / `compliance.circom` 12,743 /
`withdraw.circom` 3,058 constraints (`BASELINE.md`).

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

## 7. `recursion-spike` — one proof for many transfers
**Hypothesis:** folding (Nova) or recursive Groth16 lets N transfers be verified on-chain as ONE
proof, turning per-transfer verify gas into amortised gas.
**Metric:** on-chain verify gas per transfer at N = 1, 10, 100.
**Adversary:** none — pure scalability. This is the single largest lever in the queue if it works.
**Risk:** high. Time-box it; a negative result is a real result.

## 8. `arkworks-prover-parity` — can arkworks reproduce the transfer circuit?
**Hypothesis:** re-implementing `transfer.circom` in ark-r1cs-std produces an identical VK and
byte-compatible proofs for `sui::groth16` — the prerequisite for #7.
**Metric:** VK equality, proof verification on-chain, proving time vs snarkjs.

---

## Research track: TEE (credential issuance)

No TEE code exists in Veil today. This is the master-thesis direction (ZKP + TEE anonymous
credentials). See the `veil-tee-issuance` skill.

## 9. `tee-issuance-spike` — KYC credential issued inside an enclave
**Hypothesis:** a Nautilus / Nitro enclave can issue a Veil KYC credential (a Merkle leaf) and
attest to it, so the *issuer* never learns which on-chain identity the credential binds to.
**Metric:** what the issuer learns (today: everything). Removes the issuer from the trust base.
**Adversary:** **a curious or compromised credential issuer** — currently fully trusted, and the
weakest link in Veil's compliance story.

## 10. `tee-vs-zk-revocation` — revocation without a trusted issuer
**Hypothesis:** enclave-attested revocation lists beat accumulator-based revocation (RSA/KZG) on
cost, at the price of a hardware trust assumption. Quantify both sides before choosing.
**Metric:** revocation-check cost in-circuit; size of the trust base.
