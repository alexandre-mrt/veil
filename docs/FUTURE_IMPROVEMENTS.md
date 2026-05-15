# Future Improvements — Veil Privacy Protocol

## Current State

Veil is a **confidential compliance proof system**: transaction amounts are hidden inside ZK proofs, spending thresholds are enforced in zero-knowledge, but sender identity is visible on Sui transactions. The ZK circuit is sound and audited (4 loops, 0 critical findings).

## Use Cases (Current)

1. **Regulatory-compliant confidential transfers** — prove spending < threshold without revealing amounts
2. **Confidential payroll** — hide individual payment amounts while proving total compliance
3. **Treasury management** — hide OTC/grant amounts from public chain observers
4. **Proof of solvability** — prove "I spent < X this month" without revealing exact amount

## Upgrade Roadmap

### Tier 1 — Quick Wins (1-2 days each)

#### 1.1 Encrypted Client-Side Storage
**Fixes:** PRIV-003 (userSecret in plaintext), PRIV-009 (txHistory in plaintext)

**Files to modify:**
- `frontend/src/hooks/usePrivateState.ts`

**Changes:**
```typescript
// Replace encodeState/decodeState with encrypted versions

// 1. On first use, prompt user for a password
// 2. Derive key: crypto.subtle.deriveKey(PBKDF2, password, salt, AES-GCM-256)
// 3. Encrypt: crypto.subtle.encrypt(AES-GCM, key, JSON.stringify(state))
// 4. Store: localStorage.setItem("veil-state", base64(iv + ciphertext))
// 5. On load: prompt password, derive key, decrypt

// Key functions to add:
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 600_000, hash: "SHA-256" },
    keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

async function encryptState(state: VeilPrivateState, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(state))
  );
  // Concatenate iv + ciphertext, base64 encode
}
```

Also encrypt `frontend/src/lib/txHistory.ts` — store commitment hashes instead of plaintext amounts.

---

#### 1.2 Commitment Maturity Period
**Fixes:** PRIV-007 (PTB deposit+transfer atomic link), PRIV-010 (timing correlation)

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

#### 2.1 Relayer Pattern
**Fixes:** PRIV-001 (cross-epoch linking), PRIV-002 (sender deanonymization), PRIV-006 (gas fingerprinting)

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

#### 2.2 ZK-Proven Withdrawal
**Fixes:** PRIV-011 (admin-gated centralized withdrawal)

**New files:**
- `circuits/withdraw.circom` — new circuit
- `contracts/sources/pool.move` — add `zk_withdraw` function

**Withdraw circuit (4 public inputs):**
```circom
template Withdraw() {
    signal input commitment;       // The commitment to redeem
    signal input amount;           // Amount to withdraw (public for token transfer)
    signal input nullifier;        // Prevents double-withdraw
    signal input recipient;        // Sui address to receive tokens

    signal input cumulativeOld;    // Private: current cumulative
    signal input randomnessOld;    // Private: commitment randomness
    signal input userSecret;       // Private: proves ownership

    // Prove commitment ownership
    component commHash = Poseidon(4);
    commHash.inputs[0] <== 1;
    commHash.inputs[1] <== cumulativeOld;
    commHash.inputs[2] <== randomnessOld;
    commHash.inputs[3] <== userSecret;
    commitment === commHash.out;

    // Prove amount <= cumulativeOld (can only withdraw what you deposited)
    component ltAmount = LessEqThan(64);
    ltAmount.in[0] <== amount;
    ltAmount.in[1] <== cumulativeOld;
    ltAmount.out === 1;

    // Nullifier for withdrawal (domain tag 4)
    component nfHash = Poseidon(3);
    nfHash.inputs[0] <== 4;
    nfHash.inputs[1] <== userSecret;
    nfHash.inputs[2] <== randomnessOld;
    nullifier === nfHash.out;
}
```

**Contract changes:**
```move
public fun zk_withdraw(
    pool: &mut Pool,
    withdraw_proof_bytes: vector<u8>,
    withdraw_inputs_bytes: vector<u8>,  // 128 bytes (4 * 32)
    clock: &sui::clock::Clock,
    ctx: &mut TxContext,
) {
    assert!(!pool.frozen, E_FROZEN);
    // Verify withdraw proof with separate VK
    let valid = verifier::verify_withdraw_proof(&pool.withdraw_vk, withdraw_proof_bytes, withdraw_inputs_bytes);
    assert!(valid, E_INVALID_PROOF);

    // Extract commitment, amount, nullifier, recipient from public inputs
    let commitment = extract_bytes(&withdraw_inputs_bytes, 0, 32);
    let amount = le_bytes_to_u64(&withdraw_inputs_bytes, 32);
    let nullifier = extract_bytes(&withdraw_inputs_bytes, 64, 96);
    let recipient_bytes = extract_bytes(&withdraw_inputs_bytes, 96, 128);

    // Consume commitment (UTXO)
    assert!(dynamic_field::exists_(&pool.id, CommitmentKey { bytes: commitment }), E_COMMITMENT_CHAIN_BROKEN);
    dynamic_field::remove<CommitmentKey, u64>(&mut pool.id, CommitmentKey { bytes: commitment });

    // Check nullifier
    let nf_key = NullifierKey { bytes: nullifier };
    assert!(!dynamic_field::exists_(&pool.id, nf_key), E_NULLIFIER_SPENT);
    dynamic_field::add(&mut pool.id, nf_key, true);

    // Transfer tokens
    let withdrawn = coin::from_balance(balance::split(&mut pool.balance, amount), ctx);
    transfer::public_transfer(withdrawn, /* decode recipient from bytes */);
}
```

---

#### 2.3 Merkle Tree Accumulator
**Fixes:** PRIV-005 (UTXO chain tracing via dynamic field changes)

**Files to modify:**
- `contracts/sources/pool.move` — replace dynamic field commitments with Merkle root
- `circuits/transfer.circom` — add Merkle membership proof

**Pool changes:**
```move
public struct Pool has key {
    // ... existing fields ...
    commitment_root: vector<u8>,  // 32-byte Poseidon Merkle root
    next_leaf_index: u64,         // Next available leaf position
}

// Instead of dynamic_field::exists_ for oldCommitment,
// verify Merkle membership proof in the circuit:
// The circuit proves: oldCommitment ∈ MerkleTree(commitment_root)
```

**Circuit changes (add ~7,200 constraints for 20-level tree):**
```circom
// Add to Transfer template:
signal input merkleRoot;          // Public: current tree root
signal input pathElements[20];    // Private: sibling hashes
signal input pathIndices[20];     // Private: left/right flags

// Verify old commitment is in the tree
component merkleProof = MerkleProof(20);
merkleProof.leaf <== oldCommitment;
merkleProof.root <== merkleRoot;
for (var i = 0; i < 20; i++) {
    merkleProof.pathElements[i] <== pathElements[i];
    merkleProof.pathIndices[i] <== pathIndices[i];
}
```

**On-chain:** Only the root changes. Observers see "root updated" but NOT which leaf was consumed. Nullifiers still prevent double-spend.

**Anonymity set = all commitments ever inserted** (not just current epoch).

---

### Tier 3 — Full Privacy Protocol (1-2 months)

#### 3.1 KYC Compliance Circuit
**Already designed in veil-anonymous-creds skill (~7,200 constraints)**

When cumulative spending exceeds threshold, user provides a SECOND proof proving membership in a KYC credential Merkle tree. Identity still hidden — only "I have a valid KYC credential" is proved.

**New circuit:** `circuits/compliance.circom`
**Contract:** Add `compliance_vk` to Pool, verify both proofs in `shielded_transfer` when threshold exceeded.

#### 3.2 ElGamal Auditor Pattern
**Already designed in veil-compliance skill**

Each transfer includes an ElGamal encryption of (amount, randomness) under an auditor public key. The auditor can decrypt if legally required. Observers see only ciphertext.

**Contract:** Add `auditor_key` to Pool. Each TransferEvent includes `encrypted_amount: vector<u8>`.
**Circuit:** Add constraint proving ElGamal ciphertext encrypts the same amount used in the commitment.

---

## Privacy Level After Each Tier

| Property | Current | +Tier 1 | +Tier 2 | +Tier 3 |
|----------|---------|---------|---------|---------|
| Amount hidden | ✅ | ✅ | ✅ | ✅ |
| Threshold enforced | ✅ | ✅ | ✅ | ✅ |
| Client secrets encrypted | ❌ | ✅ | ✅ | ✅ |
| Deposit-transfer unlinkable | ❌ | ✅ | ✅ | ✅ |
| Sender anonymous | ❌ | ❌ | ✅ | ✅ |
| UTXO chain hidden | ❌ | ❌ | ✅ | ✅ |
| Self-serve withdrawal | ❌ | ❌ | ✅ | ✅ |
| KYC without identity reveal | ❌ | ❌ | ❌ | ✅ |
| Regulatory selective disclosure | ❌ | ❌ | ❌ | ✅ |

## Red Team Findings Reference

Full report: `docs/privacy-red-team-report.md`

| ID | Severity | Title | Fixed By |
|----|----------|-------|----------|
| PRIV-001 | CRITICAL | Cross-epoch identity linking via same address | Tier 2.1 (relayer) |
| PRIV-002 | CRITICAL | Sender visible in Sui tx metadata | Tier 2.1 (relayer) |
| PRIV-003 | CRITICAL | userSecret plaintext in localStorage | Tier 1.1 (encryption) |
| PRIV-004 | HIGH | Deposit amount visible on-chain | ✅ Fixed (standard denominations) |
| PRIV-005 | HIGH | UTXO chain traceable via dynamic fields | Tier 2.3 (Merkle tree) |
| PRIV-006 | HIGH | Gas coin fingerprinting | Tier 2.1 (relayer) |
| PRIV-007 | HIGH | PTB atomic deposit+transfer link | Tier 1.2 (maturity) |
| PRIV-008 | MEDIUM | Anonymity set likely = 1 | Tier 2.3 (Merkle tree) |
| PRIV-009 | MEDIUM | txHistory plaintext in localStorage | Tier 1.1 (encryption) |
| PRIV-010 | MEDIUM | Timing correlation deposit→transfer | Tier 1.2 (maturity) |
| PRIV-011 | MEDIUM | Admin-gated withdrawal (censorship) | Tier 2.2 (ZK withdrawal) |
| PRIV-012 | LOW | Proof generation time side channel | Accept (fixed-size circuit) |
| PRIV-013 | LOW | Mock proof mode zero privacy | Accept (dev-only) |
| PRIV-014 | INFO | IP leakage via RPC | Standard (use Tor/VPN) |
| PRIV-015 | INFO | txAmountHash future correlation | Accept (salt required) |
