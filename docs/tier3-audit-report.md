# Tier 3 Aggregate Audit Report

**Date:** 2026-05-15
**Scope:** Veil Privacy Protocol — Tier 3 (KYC Compliance + ElGamal Auditor)
**Agents:** 10 specialized auditors + 1 privacy red team (Opus)
**Files audited:** pool.move, compliance.move, verifier.move, token.move, transfer.circom, compliance.circom, merkle_proof.circom, proof-converter.ts, useAuditorEncryption.ts, useComplianceProof.ts, useCompliantTransfer.ts

---

## Executive Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 5 |
| HIGH | 8 |
| MEDIUM | 10 |
| LOW | 7 |
| INFO | 3 |
| **Total** | **33** |

The Tier 3 implementation is architecturally sound but has **5 critical findings** requiring fixes before deployment. The most severe: `shielded_transfer` bypasses compliance entirely (4 agents confirmed), and the context binding between transfer and compliance proofs creates a public linkability signal.

---

## CRITICAL Findings

### [C1] Compliance bypass via shielded_transfer
**Agents:** ACCESS-001 + OBJ-03 + XPROTO-001 + DEFI
**Location:** pool.move:84 (shielded_transfer is public)
**Description:** Nothing prevents a user from calling `pool::shielded_transfer` directly, bypassing the compliance check entirely. The pool has no `compliance_required` flag.
**Fix:** Add `compliance_required: bool` to Pool. When true, `shielded_transfer` asserts `!pool.compliance_required`. Only `verify_and_execute_transfer` (package-internal) remains open.

### [C2] Admin can drain pool without timelock
**Agents:** DEFI-001 + ACCESS-006 + FLASH-02
**Location:** pool.move:220-233
**Description:** `withdraw` lets AdminCap holder extract any amount with no timelock, no multisig, no commitment invalidation. Also blocked when frozen (design conflict).
**Fix:** Implement propose+wait+execute timelock pattern. Remove frozen check from withdraw (or add separate `emergency_withdraw`).

### [C3] Flash loan deposit + transfer in one PTB
**Agents:** FLASH-01
**Location:** pool.move:75 + pool.move:84
**Description:** Borrowed tokens can be used in `deposit_and_register` + `shielded_transfer` atomically in one PTB with pre-computed proofs.
**Fix:** Commitment maturity period (Tier 1.2) — new commitments cannot be consumed in the same epoch they were created.

### [C4] Context binding publicly links transfer and compliance proofs
**Agents:** PRIV-016
**Location:** compliance.move:106, compliance.circom:63-67
**Description:** `contextId = transfer_nullifier` is a public input in both proofs and emitted in CompliantTransferEvent. An adversary who obtains userSecret can verify the link. Creates targeted deanonymization oracle.
**Fix:** Use `contextId = Poseidon(transfer_nullifier, randomSalt)` and prove the binding in ZK without revealing the plaintext link.

### [C5] Credential nullifier creates permanent linkability registry
**Agents:** PRIV-017
**Location:** compliance.move:113-130
**Description:** Each compliant transfer burns a unique credential nullifier stored on ComplianceConfig. The nullifier set on ComplianceConfig is publicly enumerable via `sui_getDynamicFields`, revealing exact count of all compliant transfers.
**Fix:** Store credential nullifiers on Pool object (mixed with transfer nullifiers) or use epoch-scoped nullifiers.

---

## HIGH Findings

### [H1] VK accepted without format validation (5 agents)
**Location:** pool.move:236, compliance.move:create_compliance_config
**Fix:** Validate VK byte length before storing.

### [H2] Credential root update has no timelock (2 agents)
**Location:** compliance.move:142-153
**Fix:** Mirror the VK pattern: pending_credential_root + 1-epoch delay.

### [H3] Dual event emission leaks privacy (2 agents)
**Location:** compliance.move:134 + pool.move:140
**Description:** CompliantTransferEvent AND TransferEvent emitted for the same transfer. Different event types = binary classification of users.
**Fix:** All transfers emit the same event type. Regular transfers include dummy encrypted_amount and credential_nullifier.

### [H4] Encrypted amount length leaks amount range
**Location:** useAuditorEncryption.ts:165
**Description:** JSON.stringify creates variable-length plaintext. AES-GCM preserves length.
**Fix:** Pad plaintext to fixed 128 bytes before encryption.

### [H5] Withdraw blocked when pool is frozen
**Location:** pool.move:228
**Fix:** Remove frozen check from withdraw, or add emergency_withdraw.

### [H6] Credential root updates reveal KYC onboarding timing
**Location:** compliance.move:142-153
**Fix:** Batch updates on fixed schedule regardless of actual activity.

### [H7] requiredKycLevel as public input reveals compliance tier
**Location:** compliance.circom:92
**Fix:** Embed as circuit constant at compile time.

### [H8] Faucet unrestricted (5 agents — testnet only)
**Location:** token.move:34-37
**Fix:** Gate behind admin or remove before mainnet.

---

## MEDIUM Findings

### [M1] Magic number 8 in compliance.move (7 agents)
**Fix:** Define `const E_EPOCH_MISMATCH: u64 = 8;` locally.

### [M2] No event for update_required_kyc_level (2 agents)
**Fix:** Emit KycLevelUpdatedEvent.

### [M3] State mutation before full validation
**Location:** compliance.move:93
**Fix:** Verify both proofs before any state mutation.

### [M4] UpgradeCap not handled (INFRA-02)
**Fix:** Burn UpgradeCap at deployment or lock behind multisig.

### [M5] HKDF with zero salt (2 agents)
**Fix:** Use ephemeral public key as HKDF salt.

### [M6] G2 swap comment contradicts code (CRYPTO-002)
**Fix:** Remove misleading "Testing: NO swap" comment.

### [M7] Epoch boundary race (ORACLE-03)
**Fix:** Accept proof_epoch == current or current-1.

### [M8] Dual-proof timing side channel (PRIV-022)
**Fix:** Add random delay to regular transfers.

### [M9] encrypted_amount not validated on-chain (PRIV-025)
**Fix:** Assert fixed expected length.

### [M10] localStorage plaintext for credentials (PRIV-026)
**Fix:** PBKDF2 + AES-GCM encryption (Tier 1.1).

---

## LOW Findings

[L1] u8 shift overflow latent in le_bytes_to_u64 (ARITH-001)
[L2] Epoch overflow in propose_vk_update (ARITH-002)
[L3] Duplicated code: shielded_transfer / verify_and_execute_transfer (INFRA-06)
[L4] Error codes 12-13 gap (INFRA-08)
[L5] Pending VK can be silently overwritten (XPROTO-005)
[L6] deposit() without commitment = permanent fund lock (CRYPTO-006)
[L7] Comparator outputs not constrained binary (CRYPTO-005)

---

## INFO

[I1] Auditor key rotation creates ciphertext epoch boundaries (PRIV-023)
[I2] validCredential circuit allows proving with invalid credential (PRIV-028)
[I3] ComplianceConfig dynamic fields reveal system activity (PRIV-029)

---

## Remediation Priority

### P0 — Fix Before Any Deployment
1. **[C1]** Add `compliance_required` flag to Pool
2. **[C4]** Hash contextId binding (ZK, not plaintext)
3. **[C5]** Move credential nullifiers to Pool object
4. **[H3]** Unify event types (same struct for all transfers)
5. **[M1]** Replace magic number 8

### P1 — Fix Before Testnet Demo
6. **[C3]** Commitment maturity period
7. **[H1]** VK byte length validation
8. **[H4]** Fixed-length plaintext padding for auditor encryption
9. **[H2]** Credential root timelock
10. **[M3]** Verify-then-execute ordering

### P2 — Fix Before Mainnet
11. **[C2]** Withdraw timelock + emergency path
12. **[H5]** Remove frozen check from withdraw
13. **[M4]** Burn UpgradeCap
14. **[M5]** HKDF salt from ephemeral key
15. **[H8]** Remove or gate faucet

### P3 — Improve When Possible
16-33. All LOW + INFO findings

---

## Coverage Matrix

| Domain | Agent | Findings | Status |
|--------|-------|----------|--------|
| Arithmetic | audit-arithmetic | 8 | Complete |
| Access Control | audit-access | 8 | Complete |
| Type Safety | audit-types | 8 | Complete |
| Object Model | audit-objects | 7 | Complete |
| Crypto/Identity | audit-crypto | 7 | Complete |
| DeFi Economics | audit-defi | 9 | Complete |
| Infra/Ops | audit-infra | 10 | Complete |
| Cross-Protocol | audit-xprotocol | 6 | Complete |
| Oracle/Flash | audit-oracle-flash | 7 | Complete |
| Privacy Red Team | red-team-privacy | 15 | Complete |

**Total raw findings: 85 → 33 unique after deduplication and cross-referencing**
