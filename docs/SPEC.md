# Ground Truth: Interfaces & Contracts (v2 -- post-audit final)

## Circuit Interfaces (v2)

### transfer.circom -- Public Inputs (6, order matters)
```
signal input oldCommitment;      // Poseidon(1, cumulative_old, randomness_old, userSecret)
signal input newCommitment;      // Poseidon(1, cumulative_new, randomness_new, userSecret)
signal input threshold;          // KYC-free limit
signal input epochId;            // Current epoch from Clock
signal input nullifier;          // Poseidon(2, userSecret, epochId, randomnessOld)
signal input txAmountHash;       // Poseidon(3, txAmount, salt)
```

### transfer.circom -- Private Inputs (7)
```
signal input cumulativeOld, cumulativeNew, txAmount;
signal input randomnessOld, randomnessNew, userSecret, salt;
```

### Circuit Constraints (11)
```
C1:  oldCommitment === Poseidon(1, cumOld, randOld, userSecret)     [Poseidon(4)]
C2:  newCommitment === Poseidon(1, cumNew, randNew, userSecret)     [Poseidon(4)]
C3:  cumNew === cumOld + txAmount                                   [Addition]
C4:  txAmount > 0                                                   [GreaterThan(64)]
C5:  cumOld fits 64 bits                                            [Num2Bits(64)]
C6:  txAmount fits 64 bits                                          [Num2Bits(64)]
C7:  cumNew fits 64 bits                                            [Num2Bits(64)]
C8:  threshold fits 64 bits                                         [Num2Bits(64)]
C9:  cumNew <= threshold                                            [LessEqThan(64)]
C10: nullifier === Poseidon(2, userSecret, epochId, randOld)        [Poseidon(4)]
C11: txAmountHash === Poseidon(3, txAmount, salt)                   [Poseidon(3)]
```

### Domain Separation Tags
```
Tag 1 → Commitment:  Poseidon(1, cumulative, randomness, userSecret)
Tag 2 → Nullifier:   Poseidon(2, userSecret, epochId, randomnessOld)
Tag 3 → AmountHash:  Poseidon(3, txAmount, salt)
```

### Key Changes from v1
- Commitments: Poseidon(4) with userSecret (was Poseidon(3)) -- CRYPTO-004
- Nullifiers: Poseidon(4) with randomnessOld -- multiple txs per epoch -- CRYPTO-006
- txAmountHash: domain tag 3 (was no tag) -- CRYPTO-011
- Threshold: range-proved via Num2Bits(64) (was unconstrained)

## Contract: veil::pool (v2)

### State model: UTXO-style commitments
- Old commitment CONSUMED (dynamic_field::remove) on each transfer
- New commitment CREATED (dynamic_field::add)
- Nullifier stored permanently (prevents replay)

### Pool Object
```move
public struct Pool has key {
    id: UID,
    balance: Balance<TOKEN>,
    transfer_vk: vector<u8>,
    threshold: u64,
    frozen: bool,
    pending_vk: vector<u8>,
    vk_update_epoch: u64,
}
```

### AdminCap Object
```move
public struct AdminCap has key {
    id: UID,
    pool_id: ID,       // Bound to specific pool
}
```

### Dynamic Field Keys
```move
public struct NullifierKey has copy, drop, store { bytes: vector<u8> }   // → bool
public struct CommitmentKey has copy, drop, store { bytes: vector<u8> }  // → bool
```

### Functions
- `create_pool(transfer_vk, threshold, ctx)` -- creates shared Pool + AdminCap
- `deposit(pool, coin, ctx)` -- deposit only (standard amounts, MIN_DEPOSIT)
- `deposit_and_register(pool, coin, commitment, ctx)` -- deposit + register genesis commitment
- `shielded_transfer(pool, proof, inputs, clock, ctx)` -- verify + consume old + store nullifier + create new
- `withdraw(pool, cap, amount, recipient, ctx)` -- AdminCap-gated
- `propose_vk_update(pool, cap, new_vk, clock)` -- 1-epoch timelock
- `freeze_pool(pool, cap)` / `unfreeze_pool(pool, cap)` -- AdminCap-gated emergency stop

### Standard Deposit Denominations
```move
const DENOM_SMALL: u64 = 100_000_000;   // 100 TOKEN (6 decimals)
const DENOM_MEDIUM: u64 = 500_000_000;  // 500 TOKEN
const DENOM_LARGE: u64 = 1_000_000_000; // 1000 TOKEN
const MIN_DEPOSIT: u64 = 1_000;         // 0.001 TOKEN
```

### Error Codes
```
E_FROZEN = 1                    Pool is frozen
E_NULLIFIER_SPENT = 2           Nullifier already used (replay)
E_INVALID_PROOF = 3             Groth16 verification failed
E_NOT_POOL_ADMIN = 4            AdminCap.pool_id != pool.id
E_THRESHOLD_MISMATCH = 5        Proof threshold != pool threshold
E_INSUFFICIENT_BALANCE = 6      Withdraw exceeds balance
E_INVALID_INPUTS_LENGTH = 7     inputs != 192 bytes or commitment != 32 bytes
E_EPOCH_MISMATCH = 8            Proof epoch != Clock epoch
E_COMMITMENT_CHAIN_BROKEN = 9   Old commitment not found (UTXO consumed)
E_COMMITMENT_EXISTS = 10        New commitment already exists
E_DUST_DEPOSIT = 11             Deposit below MIN_DEPOSIT
E_NON_STANDARD_AMOUNT = 14      Deposit not 100/500/1000 TOKEN
```

### Events (privacy-preserving)
```move
DepositEvent { pool_id: ID }
TransferEvent { nullifier: vector<u8>, new_commitment: vector<u8> }
WithdrawEvent { pool_id: ID }
VKUpdateProposedEvent { pool_id: ID, effective_epoch: u64 }
FreezeEvent { pool_id: ID, frozen: bool }
```

## Contract: veil::verifier

```move
public(package) fun verify_transfer_proof(
    vk_bytes: &vector<u8>,
    proof_bytes: vector<u8>,
    public_inputs_bytes: vector<u8>,
): bool
// Uses: sui::groth16 with bn254() curve ID
```

## Contract: veil::token

```move
public struct TOKEN has drop {}

// 6 decimals, symbol "VEIL"
const FAUCET_AMOUNT: u64 = 1_000_000_000; // 1000 VEIL

fun init(witness, ctx)           // Creates currency + TreasuryCap
pub fun mint(treasury, amount, recipient, ctx)
pub fun faucet(treasury, ctx)    // Mints FAUCET_AMOUNT to caller
```

## Public Input Byte Layout (on-chain extraction)

```
Offset     Field            Extraction
0..32      oldCommitment    extract_bytes(0, 32)  → CommitmentKey (consumed)
32..64     newCommitment    extract_bytes(32, 64) → CommitmentKey (created)
64..96     threshold        le_bytes_to_u64(64), assert_upper_bytes_zero(72, 96)
96..128    epochId          le_bytes_to_u64(96), assert_upper_bytes_zero(104, 128)
128..160   nullifier        extract_bytes(128, 160) → NullifierKey (stored)
160..192   txAmountHash     Not extracted on-chain
```

## Proof Converter (scripts/src/proof-converter.ts)

### Exports
```typescript
bigintToLE32(n: bigint): Uint8Array                                // 32-byte LE
compressG1(x: bigint, y: bigint): Uint8Array                      // 32 bytes, sign bit MSB
compressG2(x0, x1, y0, y1: bigint): Uint8Array                    // 64 bytes, lex sign
proofToSuiBytes(proof: SnarkjsProof): Uint8Array                  // 128 bytes total
publicInputsToSuiBytes(signals: string[]): Uint8Array              // N * 32 bytes
vkToSuiBytes(vk: SnarkjsVK): Uint8Array                           // 32 + 64*3 + 8 + IC*32
```

### Proof Layout (128 bytes)
```
[0..31]   A (G1 compressed)
[32..95]  B (G2 compressed)
[96..127] C (G1 compressed)
```

### VK Layout
```
[0..31]     alpha_g1 (G1)
[32..95]    beta_g2 (G2)
[96..159]   gamma_g2 (G2)
[160..223]  delta_g2 (G2)
[224..231]  ic_len (u64 LE)
[232..]     IC[0..n] (G1 each, 32 bytes)
```

## Test Summary

| Layer | File | Count | Coverage |
|-------|------|-------|---------|
| Move | contracts/tests/pool_tests.move | 37 | Every function, every error code, edge cases |
| Circuit | circuits/test/transfer.test.mjs | 40 | Every constraint (C1-C11), boundaries, domain separation |
| Converter | scripts/src/test-converter.ts | 109 | bigintToLE32, G1/G2 compression, sign bits, VK layout |
| **Total** | -- | **186** | **0 failures** |

## Testnet Deployment

```
Package: 0xd0598d2256bfa33b8324bc6316cee1118f9131cdde346f8f1f757adb594a66bb
Chain: testnet (4c78adac)
Toolchain: sui 1.72.1, Move edition 2024
```

## Compliance Circuit (v3)

### compliance.circom -- Public Inputs (6, order matters)
```
signal input merkleRoot;         // Root of the KYC credential Merkle tree
signal input currentEpoch;       // Current epoch from Clock
signal input contextId;          // Pool ID binding (prevents cross-pool replay)
signal input requiredKycLevel;   // Minimum KYC tier required by pool config
signal input nullifier;          // Poseidon(5, credentialSecret, currentEpoch, contextId)
signal input validCredential;    // 1 if credential is valid and unexpired, 0 otherwise
```

### Domain Separation Tags
```
Tag 4 → Credential leaf:      Poseidon(4, kycLevel, expiry, credentialSecret, contextId)
Tag 5 → Credential nullifier: Poseidon(5, credentialSecret, currentEpoch, contextId)
```

### Constraint Count
12,743 R1CS constraints (6,057 non-linear), measured with `snarkjs r1cs info` on the compiled circuit:
- Poseidon(5) leaf hash
- 20-level Merkle membership proof
- Nullifier preimage check
- Expiry validation (currentEpoch <= credential.expiry)
- KYC level check (credential.kycLevel >= requiredKycLevel)

### ComplianceConfig Struct (Move)
```move
public struct ComplianceConfig has store {
    pool_id: ID,                 // Bound to specific pool
    compliance_vk: vector<u8>,   // Groth16 VK for compliance circuit
    credential_root: vector<u8>, // Current Merkle root of KYC tree (32 bytes)
    required_kyc_level: u8,      // Minimum KYC tier (1 = basic, 2 = enhanced, 3 = full)
    auditor_key: vector<u8>,     // P-256 public key for encrypted disclosure
}
```

### Error Codes (20-26)
```
E_COMPLIANCE_DISABLED = 20      Pool does not require compliance proofs
E_INVALID_CREDENTIAL = 21       Compliance proof verification failed
E_CREDENTIAL_EXPIRED = 22       Credential epoch > currentEpoch
E_KYC_LEVEL_TOO_LOW = 23        credential.kycLevel < requiredKycLevel
E_CREDENTIAL_NULLIFIER_SPENT = 24  Credential nullifier already used this epoch
E_INVALID_MERKLE_ROOT = 25      merkleRoot does not match pool credential_root
E_AUDITOR_CIPHERTEXT_INVALID = 26  Auditor ciphertext length or format mismatch
```

### Compliance Public Input Byte Layout (192 bytes)
```
Offset     Field              Extraction
0..32      merkleRoot         extract_bytes(0, 32) — matched against pool credential_root
32..64     currentEpoch       le_bytes_to_u64(32), assert_upper_bytes_zero(40, 64)
64..96     contextId          extract_bytes(64, 96) — matched against pool.id
96..128    requiredKycLevel   le_bytes_to_u64(96), assert_upper_bytes_zero(97, 128)
128..160   nullifier          extract_bytes(128, 160) — stored as CredentialNullifierKey
160..192   validCredential    le_bytes_to_u64(160), must equal 1
```

### Auditor Encryption
- Algorithm: ECDH P-256 key agreement + AES-128-GCM symmetric encryption
- Binding: plaintext includes `txAmountHash` from the transfer proof (prevents substitution)
- Ciphertext is attached to the compliant_transfer transaction as a non-Move input
- Auditor can decrypt with their P-256 private key to recover the transaction amount
