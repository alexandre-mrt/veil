# Veil Protocol — Red Team Privacy Attack Report

**Agent:** red-team-privacy  
**Date:** 2026-05-15  
**Scope:** Full protocol — Move contracts, Circom circuits, frontend hooks, e2e test  
**Verdict:** The Veil protocol's ZK circuit is cryptographically sound, but the surrounding infrastructure provides **effectively zero sender privacy** in its current form.

---

## Executive Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 3 |
| HIGH | 4 |
| MEDIUM | 4 |
| LOW | 2 |
| INFO | 2 |
| **Total** | **15** |

The protocol suffers from a fundamental architectural flaw: **the same Sui wallet signs both deposit and shielded transfer transactions**, making the sender fully visible in on-chain metadata. The ZK proof hides amounts and commitment chains, but Sui transaction records expose the signer address, nullifying sender privacy entirely. A chain analysis firm (Chainalysis, Elliptic) could deanonymize nearly all users with basic on-chain queries.

---

## CRITICAL Findings

### PRIV-001: Deterministic Genesis Commitment Enables Cross-Epoch Identity Linking

**Location:** `pool.move:138` (`deposit_and_register`), `usePrivateState.ts:64` (`createInitialState`)

The `deposit_and_register` function requires a Sui transaction signed by the user's wallet. When a user re-registers at the start of a new epoch, the **same address** calls `deposit_and_register` again. An observer trivially links epoch N identity to epoch N+1 identity because the Sui transaction sender is identical.

**Attack:**
1. Observe `deposit_and_register` from address `0xAlice` at epoch N
2. Observe `deposit_and_register` from address `0xAlice` at epoch N+1
3. Conclude: same user across epochs

**Feasibility:** Trivial. Single GraphQL query on Sui.

**Fix:** Relayer-submitted registrations or fresh addresses per epoch.

---

### PRIV-002: Same Wallet Signs Deposit and Shielded Transfer — Full Sender Deanonymization

**Location:** `useShieldedTransfer.ts:108-119` (PTB construction), `pool.move:78` (`shielded_transfer`)

The `shielded_transfer` Move function takes `_ctx: &TxContext` (unused), but the Sui transaction itself is signed by the user's keypair. The sender address is recorded in immutable transaction metadata.

**Attack:**
1. Query Sui: "all transactions from `0xAlice` calling `veil::pool::shielded_transfer`"
2. Result: every shielded transfer Alice has ever made, with timestamps
3. The ZK proof hides amounts, but the **sender is fully exposed**

**Feasibility:** Trivial. This is the most damaging finding.

**Fix:** Implement a relayer pattern (Tornado Cash model). The relayer submits the PTB; the user sends proof data off-chain to the relayer.

---

### PRIV-003: XSS Extracts userSecret from localStorage — Full Retroactive Deanonymization

**Location:** `usePrivateState.ts:89` (localStorage read), `usePrivateState.ts:100` (localStorage write), encoding via `btoa(JSON.stringify(...))`

The `userSecret` (master private key for the entire privacy scheme) is stored as base64-encoded JSON in `localStorage["veil-state"]`.

**Attack:**
1. XSS or malicious browser extension executes: `atob(localStorage.getItem('veil-state'))`
2. Extract `userSecret`
3. Compute ALL past nullifiers: `Poseidon(2, userSecret, epochId, randomnessOld)` for every epoch
4. Match against on-chain `TransferEvent.nullifier` to reconstruct full spending history
5. Compute all commitments to derive cumulative spending at each step

**Impact:** RETROACTIVE — compromising the secret today breaks ALL past transactions.

**Feasibility:** Moderate (requires XSS or physical access).

**Fix:** Encrypt at rest with password-derived key. Consider WebAuthn-backed storage.

---

## HIGH Findings

### PRIV-004: Deposit Amount Visible On-Chain — Exact Amount Correlation

**Location:** `pool.move:71-75` (`deposit`), `pool.move:138-155` (`deposit_and_register`)

Deposit amounts are visible because the `Coin<TOKEN>` object's value is public on Sui before consumption. An observer queries the coin's value at the version before it was consumed by the deposit.

**Attack:** Deposit 1,234,567 tokens -> later, commitment chain shows cumulative spending reaching ~1,234,567 -> user identified by unique deposit amount.

**Fix:** Standardized deposit denominations (100, 1000, 10000 only).

### PRIV-005: Dynamic Field Removal Reveals Consumed Commitment — UTXO Tracing

**Location:** `pool.move:108-114` (`dynamic_field::remove`), `pool.move:126-132` (`dynamic_field::add`)

Sui transaction effects reveal which `CommitmentKey` dynamic field was removed and which was added. This exposes the full UTXO chain: `commitment_A -> commitment_B -> commitment_C -> ...`

**Attack:**
1. Monitor Pool object's dynamic field changes via Sui event subscription
2. For each `shielded_transfer` tx: record (removed_commitment, added_commitment)
3. Build complete commitment graph from genesis to current
4. Cross-reference with genesis commitments (PRIV-001) to attribute chains to users

**Feasibility:** Trivial. Sui's object model is designed for transparency.

**Fix:** Replace individual dynamic fields with a Merkle tree accumulator. Only the root changes; specific consumed commitments are hidden.

### PRIV-006: Gas Coin Fingerprinting

**Location:** `useShieldedTransfer.ts:119` (signAndExecute)

The gas coin used to pay for `shielded_transfer` is owned by the sender's address. Gas coin provenance (where the SUI came from — exchange, faucet, etc.) creates a unique fingerprint.

**Fix:** Sponsored transactions with a shared gas pool.

### PRIV-007: PTB Composition Attack — Deposit + Transfer in One Transaction

**Location:** `pool.move` — both `deposit_and_register` and `shielded_transfer` are `public` functions on the same shared object.

A single PTB can atomically call `deposit_and_register` then `shielded_transfer`, creating an irrefutable on-chain proof that the depositor is the transferor.

**Attack:**
```
PTB:
  1. pool::deposit_and_register(pool, coin, genesis_commitment)
  2. pool::shielded_transfer(pool, proof, inputs, clock)
```
One transaction, one sender, deposit and transfer atomically linked.

**Fix:** Commitment maturity period — new commitments cannot be consumed until N blocks have passed.

---

## MEDIUM Findings

### PRIV-008: Anonymity Set Likely = 1

A fresh deployment or low-usage period means the anonymity set is tiny. If only Alice deposited this epoch, all transfers are Alice's. This is the #1 practical failure of privacy protocols.

**Fix:** Display anonymity set size in UI. Add deposit incentives. Warn when set < 50 users.

### PRIV-009: Transaction History Stored in Cleartext localStorage

**Location:** `txHistory.ts` — stores `{type, amount, digest, timestamp}` in `localStorage["veil-tx-history"]`

This is a second correlation oracle beyond `userSecret`. An XSS attack extracts a complete mapping of Sui tx digests to amounts, defeating ZK amount hiding.

**Fix:** Encrypt or do not persist amounts. Use commitment hashes instead of plaintext amounts.

### PRIV-010: Timing Correlation Between Deposit and First Transfer

The default usage pattern (e2e-test.ts lines 595-606) is deposit immediately followed by transfer. Temporal proximity is a strong deanonymization signal.

**Fix:** Enforce minimum delay (commitment maturity). UI guidance to wait before first transfer.

### PRIV-011: Withdraw is Admin-Gated — Centralized Deanonymization Point

**Location:** `pool.move:157-171` (`withdraw` requires `AdminCap`)

Users cannot self-withdraw. They must request the admin, who learns: user identity, amount, and destination address. The admin is a single point of privacy failure (subpoena-able).

**Fix:** ZK-proven withdrawal: user proves commitment ownership and withdraws without revealing identity.

---

## LOW Findings

### PRIV-012: Proof Generation Time Side Channel

Client-side JavaScript bigint arithmetic is not constant-time. A local observer could theoretically infer transaction properties from proof generation duration. Practical impact is low because the circuit is fixed-size.

### PRIV-013: Mock Proof Mode Provides Zero Privacy

When circuit artifacts are missing, the frontend falls back to mock proofs (random bytes). Transactions will fail on-chain, but mock-mode state (commitments, nullifiers) persists in localStorage and could leak if the user later switches to real mode.

---

## INFO Findings

### PRIV-014: IP Address Leakage via Direct RPC Calls

Standard metadata leakage affecting all blockchain apps. The RPC provider sees the user's IP and can correlate with transaction timing.

### PRIV-015: txAmountHash as Public Input — Future Correlation Vector

`txAmountHash = Poseidon(3, txAmount, salt)` is visible in transaction input data. If the salt leaks (via PRIV-003), amounts can be brute-forced against the hash since practical amounts are a small search space.

---

## Attack Chain: Complete Deanonymization

A chain analysis firm can fully deanonymize Veil users by combining just 3 findings:

```
PRIV-002 (sender visible)
  + PRIV-005 (commitment chain traceable)
  + PRIV-004 (deposit amount visible)
  = FULL DEANONYMIZATION
```

**Step-by-step:**
1. Query all `deposit_and_register` transactions for the pool -> get (address, deposit_amount, genesis_commitment) tuples
2. Query all `shielded_transfer` transactions -> get (address, nullifier, old_commitment_removed, new_commitment_added) tuples
3. The ADDRESS in step 2 directly links to step 1 (same wallet)
4. Even without address matching, the commitment chain (step 2 removed/added fields) links back to the genesis commitment (step 1)
5. Deposit amounts (step 1) constrain the cumulative spending range

**Result:** Complete transaction graph with sender identity, deposit amounts, transfer ordering, and epoch activity. The ZK proofs only hide the individual transfer amounts within the cumulative chain — everything else is visible.

---

## Recommended Architecture Changes (Priority Order)

1. **Relayer pattern** (fixes PRIV-001, PRIV-002, PRIV-006): A relayer submits all transactions on behalf of users. Users send proof data to the relayer off-chain.

2. **Merkle tree accumulator** (fixes PRIV-005): Replace individual commitment dynamic fields with a Merkle tree. On-chain, only the root is updated; specific consumed commitments are hidden.

3. **Standardized deposit denominations** (fixes PRIV-004): Only allow deposits of fixed amounts (100, 1000, 10000 TOKEN).

4. **Commitment maturity period** (fixes PRIV-007, PRIV-010): Commitments cannot be consumed until N blocks after creation.

5. **Encrypted client-side storage** (fixes PRIV-003, PRIV-009): Encrypt userSecret and transaction history at rest.

6. **ZK-proven withdrawal** (fixes PRIV-011): Allow users to exit the pool without admin involvement.

7. **Anonymity set monitoring** (fixes PRIV-008): Display pool usage metrics; warn when privacy is weak.

---

## Conclusion

The Veil protocol's ZK circuit (transfer.circom) is well-designed: commitments are properly bound to userSecret, nullifiers are unique per transfer (not per epoch), range proofs prevent overflow, and domain separation tags prevent cross-domain hash collisions. The cryptography is sound.

However, the protocol's privacy guarantees are **fundamentally undermined by Sui's transparent transaction metadata**. The same wallet signing deposits and transfers, combined with dynamic field traceability and visible deposit amounts, means a chain analysis firm can deanonymize users with basic on-chain queries — no cryptographic attacks needed.

The protocol is currently a **confidential transaction system** (amounts are hidden within the commitment chain) rather than a **private transaction system** (sender/receiver are anonymous). Achieving true privacy requires a relayer layer, Merkle tree accumulator, and standardized denominations — none of which require changing the ZK circuit.
