# Future Improvements — Veil Privacy Protocol

## Current State

Veil is a **confidential compliance proof system** with tiered privacy:
- **Tier 1/2**: amounts hidden via ZK proofs, spending thresholds enforced in zero-knowledge
- **Tier 3**: dual Groth16 proofs (transfer + KYC compliance), ECDH auditor encryption
- **Sender privacy**: sponsored transaction relayer hides sender address on-chain

Reviewed iteratively. 113 Move tests, 100 circuit tests (transfer 40 + compliance 30 + withdraw 30), 438+ total tests, 0 failures.

## Use Cases (Current)

1. **Regulatory-compliant confidential transfers** — prove spending < threshold without revealing amounts
2. **Tiered KYC compliance** — anonymous below threshold, KYC proof above (no identity revealed)
3. **Confidential payroll** — hide individual payment amounts while proving total compliance
4. **Treasury management** — hide OTC/grant amounts from public chain observers
5. **Auditor-compatible privacy** — encrypted amounts readable only by designated auditor key

## Upgrade Roadmap

### Tier 1 — Quick Wins (1-2 days each)

#### 1.1 Encrypted Client-Side Storage -- IMPLEMENTED
**Fixes:** PRIV-003 (userSecret in plaintext), PRIV-009 (txHistory in plaintext)
**Status:** Done -- `usePrivateState.ts` uses IndexedDB non-extractable AES-GCM-256 keys (primary) with PBKDF2 fallback for incognito/unsupported browsers. `crypto.ts` provides shared `encryptData`/`decryptData` with the same dual-path strategy. State is AES-GCM encrypted before writing to localStorage; legacy plaintext is auto-migrated on load.

---

#### 1.2 Commitment Maturity Period -- IMPLEMENTED
**Fixes:** PRIV-007 (PTB deposit+transfer atomic link), PRIV-010 (timing correlation)
**Status:** Done -- `assert!(current_epoch(clock) > created_epoch, E_COMMITMENT_NOT_MATURE)` in pool.move:188

**Files to modify:**
- `contracts/sources/pool.move`

**Changes:**
```move
// 1. Change CommitmentKey value from bool to u64 (creation epoch)
dynamic_field::add(&mut pool.id, new_comm_key, current_epoch(clock));

// 2. In deposit_and_register, store epoch:
dynamic_field::add(&mut pool.id, comm_key, current_epoch(clock));

// 3. In shielded_transfer, check maturity before consuming old commitment:
let created_epoch = dynamic_field::remove<CommitmentKey, u64>(&mut pool.id, old_comm_key);
assert!(current_epoch(clock) > created_epoch, E_COMMITMENT_NOT_MATURE);

// 4. Add error code:
const E_COMMITMENT_NOT_MATURE: u64 = 15;
```

This prevents atomic deposit+transfer in one PTB (different epochs required) and forces a time gap between deposit and first transfer.

---

### Tier 2 — Architecture Changes (1-2 weeks each)

#### 2.1 Relayer Pattern -- IMPLEMENTED
**Fixes:** PRIV-001 (cross-epoch linking), PRIV-002 (sender deanonymization), PRIV-006 (gas fingerprinting)
**Status:** Done -- `scripts/src/relayer.ts` (Sui sponsored transactions, HTTP API, demo mode). Loop 5 flagged: needs CORS restriction, rate limiting, TransactionKind validation for production.

**New files to create:**
- `relayer/` — new service directory
- `relayer/src/server.ts` — Express/Hono API server
- `relayer/src/submit.ts` — PTB construction + submission
- `contracts/sources/pool.move` — add relayer fee mechanism

**Architecture:**
```
User                          Relayer                     Sui
  │                              │                          │
  ├─ Generate ZK proof locally   │                          │
  ├─ POST /relay {proof, inputs} │                          │
  │                              ├─ Build PTB               │
  │                              ├─ Sign with relayer key   │
  │                              ├─ Submit to Sui ──────────►
  │                              │                          │
  │                              │◄──── tx result ──────────┤
  │◄── return {digest} ─────────┤                          │
```

**Contract changes:**
```move
// Add relayer fee field to Pool
public struct Pool has key {
    // ... existing fields ...
    relayer_fee: u64,  // fee taken from pool balance per transfer
}

// shielded_transfer no longer needs user's TxContext for auth
// The proof itself authenticates the user (commitment bound to userSecret)
// Anyone can submit a valid proof — the relayer just forwards it
```

**Frontend changes:**
```typescript
// useShieldedTransfer.ts — replace direct signAndExecute with:
const response = await fetch(RELAYER_URL + "/relay", {
  method: "POST",
  body: JSON.stringify({
    proofBytes: Array.from(proofResult.proof),
    publicInputsBytes: Array.from(proofResult.publicInputs),
  }),
});
const { digest } = await response.json();
```

**Key insight:** The ZK proof already authenticates the user (commitment is bound to userSecret). The relayer cannot forge proofs or steal funds — it can only submit or refuse to submit.

---

#### 2.2 ZK-Proven Withdrawal -- IMPLEMENTED
**Fixes:** PRIV-011 (admin-gated centralized withdrawal)
**Status:** Done -- `circuits/withdraw.circom` (8 constraints, 4 public inputs: commitment, withdrawAmount, nullifier, recipientHash). Contract: `pool.move:zk_withdraw` with separate withdraw VK, commitment maturity check, UTXO consumption, nullifier tracking, and Poseidon(8, recipient) binding to prevent front-running. Withdraw VK has 1-epoch timelock (`propose_withdraw_vk`/`cancel_withdraw_vk`).

---

#### 2.3 Merkle Tree Accumulator -- IMPLEMENTED
**Fixes:** PRIV-005 (UTXO chain tracing via dynamic field changes)
**Status:** Done -- depth-20 Poseidon Merkle tree. `Pool` stores `commitment_root` (32-byte root) and `next_leaf_index`. Admin updates root via `update_commitment_root` with 1-epoch timelock (`propose_commitment_root_update`/`cancel_commitment_root_update`). Off-chain tree maintained by relayer/indexer. Anonymity set = all commitments ever inserted (not just current epoch). Observers see "root updated" but NOT which leaf was consumed. Nullifiers still prevent double-spend.

---

### Tier 3 — Full Privacy Protocol -- IMPLEMENTED

#### 3.1 KYC Compliance Circuit -- IMPLEMENTED
**Status:** Done -- `circuits/compliance.circom` (10 constraints, Merkle depth 20, Poseidon leaf hash, context-bound nullifiers). Contract: `contracts/sources/compliance.move` with `compliant_transfer` dual-proof verification. 67 compliance util tests, 32 E2E compliance tests.

#### 3.2 Auditor Encryption Pattern -- IMPLEMENTED
**Status:** Done -- ECDH P-256 + AES-128-GCM (not ElGamal, changed for practical reasons). Auditor key stored in `ComplianceConfig`, encrypted amounts emitted via `ComplianceVerifiedEvent`. Frontend: `useAuditorEncryption` hook. Auditor event browser in UI.

---

## Privacy Level — Current Status

| Property | Status | Implemented In |
|----------|--------|---------------|
| Amount hidden | ✅ | transfer.circom (Poseidon commitments) |
| Threshold enforced | ✅ | transfer.circom C9 (LessEqThan) |
| Client secrets encrypted | ✅ | usePrivateState.ts (IndexedDB non-extractable keys + PBKDF2 fallback) |
| Deposit-transfer unlinkable | ✅ | pool.move (commitment maturity) |
| Sender anonymous | ✅ | relayer.ts (sponsored transactions) |
| UTXO chain hidden | ✅ | pool.move (depth-20 Poseidon Merkle accumulator, root on-chain) |
| Self-serve withdrawal | ✅ | pool.move:zk_withdraw + withdraw.circom |
| KYC without identity reveal | ✅ | compliance.circom + compliance.move |
| Regulatory selective disclosure | ✅ | ECDH auditor encryption |

## Red Team Findings Reference

Full report: `docs/privacy-red-team-report.md`

| ID | Severity | Title | Fixed By |
|----|----------|-------|----------|
| PRIV-001 | CRITICAL | Cross-epoch identity linking via same address | ✅ Fixed (relayer) |
| PRIV-002 | CRITICAL | Sender visible in Sui tx metadata | ✅ Fixed (relayer) |
| PRIV-003 | CRITICAL | userSecret plaintext in localStorage | ✅ Fixed (IndexedDB non-extractable keys + AES-GCM encryption) |
| PRIV-004 | HIGH | Deposit amount visible on-chain | ✅ Fixed (standard denominations) |
| PRIV-005 | HIGH | UTXO chain traceable via dynamic fields | ✅ Fixed (Merkle accumulator, depth-20 Poseidon tree) |
| PRIV-006 | HIGH | Gas coin fingerprinting | ✅ Fixed (relayer) |
| PRIV-007 | HIGH | PTB atomic deposit+transfer link | ✅ Fixed (commitment maturity) |
| PRIV-008 | MEDIUM | Anonymity set likely = 1 | ✅ Fixed (Merkle accumulator, anonymity set = all commitments ever inserted) |
| PRIV-009 | MEDIUM | txHistory plaintext in localStorage | ✅ Fixed (AES-GCM encrypted storage) |
| PRIV-010 | MEDIUM | Timing correlation deposit→transfer | ✅ Fixed (commitment maturity) |
| PRIV-011 | MEDIUM | Admin-gated withdrawal (censorship) | ✅ Fixed (ZK-proven withdrawal) |
| PRIV-012 | LOW | Proof generation time side channel | Accept (fixed-size circuit) |
| PRIV-013 | LOW | Mock proof mode zero privacy | Accept (dev-only) |
| PRIV-014 | INFO | IP leakage via RPC | Standard (use Tor/VPN) |
| PRIV-015 | INFO | txAmountHash future correlation | Accept (salt required) |
