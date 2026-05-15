# Veil -- Architecture

## Overview

Veil is a privacy payment protocol on Sui. It combines Circom ZK circuits with native Sui Groth16 verification to let users transact with hidden amounts while enforcing spending limits in zero-knowledge. The protocol uses a UTXO-style commitment model with note-based nullifiers, enabling multiple transfers per epoch without linkability.

## System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         USER BROWSER                                  │
│  (encrypted localStorage: userSecret, cumulative, randomness, epoch)  │
│                                                                        │
│  VeilPrivateState {                                                    │
│    userSecret: bigint      // master secret, never leaves browser      │
│    currentEpoch: number    // from on-chain Clock                      │
│    cumulativeSpending: bigint                                          │
│    randomness: bigint      // blinding factor for current commitment   │
│  }                                                                     │
└──────────┬─────────────────────────────────────────────────────────────┘
           │
           │  Generate Groth16 proof (snarkjs WASM, ~2s)
           │  11 constraints, 6 public + 7 private inputs
           │
           ▼
┌──────────────────────┐
│   TRANSFER PROOF      │
│   (transfer.circom)   │
│                       │
│   6 public inputs:    │
│   • oldCommitment     │  Poseidon(1, cumOld, randOld, userSecret)
│   • newCommitment     │  Poseidon(1, cumNew, randNew, userSecret)
│   • threshold         │  KYC-free limit
│   • epochId           │  From on-chain Clock
│   • nullifier         │  Poseidon(2, userSecret, epochId, randOld)
│   • txAmountHash      │  Poseidon(3, txAmount, salt)
│                       │
│   BN254 Groth16       │
│   snarkjs WASM        │
└──────────┬───────────┘
           │
           │  proof_bytes (128) + public_inputs_bytes (192)
           │  Converted via proof-converter.ts (arkworks compressed)
           │
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  SUI MOVE CONTRACT (veil::pool)                       │
│                                                                        │
│  ┌─────────────────────┐   ┌──────────────────┐   ┌───────────────┐  │
│  │   veil::verifier     │   │  Nullifier Set   │   │  UTXO         │  │
│  │                      │   │                  │   │  Commitments  │  │
│  │  sui::groth16        │   │  dynamic_field   │   │               │  │
│  │  (BN254 native)      │   │  NullifierKey    │   │  dynamic_field│  │
│  │  prepare_vk()        │   │  → bool          │   │  CommitmentKey│  │
│  │  verify_proof()      │   │  (permanent)     │   │  → bool       │  │
│  └──────────┬──────────┘   └──────────────────┘   │  (consumed/   │  │
│             │                                      │   created)    │  │
│             │ valid proof                          └───────────────┘  │
│             ▼                                                          │
│  ┌─────────────────────┐   ┌──────────────────┐   ┌───────────────┐  │
│  │   Shielded Pool      │   │   Epoch Mgmt     │   │    Controls   │  │
│  │                      │   │                  │   │               │  │
│  │  Balance<TOKEN>      │   │  Clock object    │   │  AdminCap     │  │
│  │  deposit()           │   │  epoch_id =      │   │  frozen: bool │  │
│  │  deposit_and_register│   │  ts_ms / 30days  │   │  VK timelock  │  │
│  │  withdraw()          │   │                  │   │               │  │
│  └─────────────────────┘   └──────────────────┘   └───────────────┘  │
│                                                                        │
│  Standard deposits: 100 | 500 | 1000 TOKEN (amount correlation resist)│
│                                                                        │
│  Error codes:                                                          │
│  E_FROZEN(1) | E_NULLIFIER_SPENT(2) | E_INVALID_PROOF(3) |            │
│  E_NOT_POOL_ADMIN(4) | E_THRESHOLD_MISMATCH(5) |                      │
│  E_INSUFFICIENT_BALANCE(6) | E_INVALID_INPUTS_LENGTH(7) |             │
│  E_EPOCH_MISMATCH(8) | E_COMMITMENT_CHAIN_BROKEN(9) |                 │
│  E_COMMITMENT_EXISTS(10) | E_DUST_DEPOSIT(11) |                       │
│  E_NON_STANDARD_AMOUNT(14)                                             │
└──────────────────────────────────────────────────────────────────────┘
```

## Circuit Architecture (v2 -- post-audit)

### transfer.circom

```
PUBLIC INPUTS (6)                    PRIVATE INPUTS (7)
─────────────────                    ──────────────────
oldCommitment                        cumulativeOld
newCommitment                        cumulativeNew
threshold         ──────────────►    txAmount
epochId           CONSTRAINTS        randomnessOld
nullifier                            randomnessNew
txAmountHash                         userSecret
                                     salt

CONSTRAINTS (11 total):

[C1]  oldCommitment == Poseidon(1, cumOld, randOld, userSecret)   ← Poseidon(4)
[C2]  newCommitment == Poseidon(1, cumNew, randNew, userSecret)   ← Poseidon(4)
[C3]  cumNew == cumOld + txAmount
[C4]  txAmount > 0                                                ← GreaterThan(64)
[C5]  cumulativeOld in [0, 2^64)                                  ← Num2Bits(64)
[C6]  txAmount in [0, 2^64)                                       ← Num2Bits(64)
[C7]  cumulativeNew in [0, 2^64)                                  ← Num2Bits(64)
[C8]  threshold in [0, 2^64)                                      ← Num2Bits(64)
[C9]  cumNew <= threshold                                         ← LessEqThan(64)
[C10] nullifier == Poseidon(2, userSecret, epochId, randOld)      ← Poseidon(4)
[C11] txAmountHash == Poseidon(3, txAmount, salt)                 ← Poseidon(3)

Domain separation tags:
  tag 1 → commitment hashes  H(1, cumulative, randomness, userSecret)
  tag 2 → nullifier hashes   H(2, userSecret, epochId, randomnessOld)
  tag 3 → amount hashes      H(3, txAmount, salt)
```

### Key Changes from v1 (audit fixes)
- **CRYPTO-004**: Commitments bound to `userSecret` via Poseidon(4) -- prevents commitment theft
- **CRYPTO-006**: Note-based nullifiers include `randomnessOld` -- multiple transfers per epoch
- **CRYPTO-011**: txAmountHash uses domain tag 3 -- prevents cross-domain hash collision
- **Threshold range proof (C8)**: Added Num2Bits(64) on threshold -- was unconstrained in v1

## Contract Architecture (v2 -- UTXO model)

### State Model: UTXO-style commitments

Each shielded transfer performs an atomic state transition:
1. **Consume**: old commitment removed from dynamic fields (assert exists)
2. **Nullify**: nullifier stored permanently (assert not exists)
3. **Create**: new commitment added to dynamic fields (assert not exists)

This prevents parallel chain attacks where a user could create multiple spending chains from the same commitment.

### Functions

| Function | Access | Description |
|----------|--------|-------------|
| `create_pool(vk, threshold, ctx)` | Public | Creates shared Pool + AdminCap |
| `deposit_and_register(pool, coin, commitment, ctx)` | Public | Deposit + register genesis commitment |
| `deposit(pool, coin, ctx)` | Public | Deposit additional tokens (standard amounts only) |
| `shielded_transfer(pool, proof, inputs, clock, ctx)` | Public | Core: verify + consume old + store nullifier + create new |
| `withdraw(pool, cap, amount, recipient, ctx)` | AdminCap | Emergency withdraw |
| `propose_vk_update(pool, cap, new_vk, clock)` | AdminCap | Stage VK update (1-epoch timelock) |
| `freeze_pool(pool, cap)` / `unfreeze_pool(pool, cap)` | AdminCap | Emergency stop/resume |

### Standard Deposit Denominations
- `DENOM_SMALL`: 100,000,000 (100 TOKEN at 6 decimals)
- `DENOM_MEDIUM`: 500,000,000 (500 TOKEN)
- `DENOM_LARGE`: 1,000,000,000 (1000 TOKEN)

Non-standard amounts are rejected with `E_NON_STANDARD_AMOUNT (14)`.

## Transaction Flow

### Shielded Transfer

```
1. BROWSER
   ├── Load VeilPrivateState from encrypted localStorage
   ├── Compute Poseidon hashes (circomlibjs)
   │     oldCommitment = Poseidon(1, cumOld, randOld, userSecret)
   │     newCommitment = Poseidon(1, cumOld + amount, randNew, userSecret)
   │     nullifier     = Poseidon(2, userSecret, epochId, randOld)
   │     txAmountHash  = Poseidon(3, amount, salt)
   ├── Generate Groth16 proof (snarkjs WASM in Web Worker)
   └── Convert proof to Sui bytes (proof-converter.ts)

2. SUI TRANSACTION
   └── pool::shielded_transfer(pool, proof_bytes, public_inputs_bytes, clock)
         ├── assert!(!pool.frozen)                        → E_FROZEN(1)
         ├── assert!(inputs.length() == 192)              → E_INVALID_INPUTS_LENGTH(7)
         ├── apply_pending_vk(pool, clock)                → VK timelock check
         ├── Extract threshold from bytes[64..72] (LE u64)
         │   assert_upper_bytes_zero(bytes, 72, 96)       → E_INVALID_INPUTS_LENGTH(7)
         │   assert!(proof_threshold == pool.threshold)   → E_THRESHOLD_MISMATCH(5)
         ├── Extract epoch from bytes[96..104] (LE u64)
         │   assert_upper_bytes_zero(bytes, 104, 128)     → E_INVALID_INPUTS_LENGTH(7)
         │   assert!(proof_epoch == current_epoch(clock))  → E_EPOCH_MISMATCH(8)
         ├── verifier::verify_transfer_proof(vk, proof, inputs)
         │     └── sui::groth16::verify_groth16_proof()   → E_INVALID_PROOF(3)
         ├── Extract old_commitment[0..32]
         │   assert!(CommitmentKey exists)                → E_COMMITMENT_CHAIN_BROKEN(9)
         │   dynamic_field::remove()  ← UTXO consumed
         ├── Extract nullifier[128..160]
         │   assert!(!NullifierKey exists)                → E_NULLIFIER_SPENT(2)
         │   dynamic_field::add(nullifier → true)
         ├── Extract new_commitment[32..64]
         │   assert!(!CommitmentKey exists)               → E_COMMITMENT_EXISTS(10)
         │   dynamic_field::add(commitment → true)
         └── event::emit(TransferEvent { nullifier, new_commitment })

3. BROWSER (after tx confirmed)
   ├── Update cumulativeSpending += amount
   ├── Update randomness = randomnessNew
   └── Persist VeilPrivateState to encrypted localStorage
```

### Deposit and Register (genesis)

```
User → pool::deposit_and_register(pool, Coin<TOKEN>, commitment)
         ├── assert!(!pool.frozen)                       → E_FROZEN(1)
         ├── assert!(coin.value() >= MIN_DEPOSIT)        → E_DUST_DEPOSIT(11)
         ├── assert!(is_standard_amount(amount))         → E_NON_STANDARD_AMOUNT(14)
         ├── assert!(commitment.length() == 32)          → E_INVALID_INPUTS_LENGTH(7)
         ├── assert!(!CommitmentKey exists)               → E_COMMITMENT_EXISTS(10)
         ├── balance::join(pool.balance, coin)
         ├── dynamic_field::add(commitment → true)
         └── event::emit(DepositEvent { pool_id })
```

## Epoch Design

```
Timeline:
│────────────────────────────────────────────────────────
│  Epoch 0          │  Epoch 1          │  Epoch 2
│  [0, 30 days)     │  [30, 60 days)    │  [60, 90 days)
│
│  Genesis: Poseidon(1, 0, 0, userSecret) ← user-specific
│
│                   │ Epoch boundary
│                   │  New genesis:    Poseidon(1, 0, 0, userSecret)
│                   │  cumulativeOld reset to 0
│                   │  randomness reset to 0
│                   │  New nullifier is unique (different randOld)
│
│  epoch_id = Clock::timestamp_ms() / EPOCH_DURATION_MS
│  EPOCH_DURATION_MS = 2_592_000_000  (30 days in ms)
```

## Public Input Byte Layout

The Sui verifier reads public inputs as a flat byte array. Each input is 32 bytes (little-endian BN254 scalar field element).

```
Offset     Field            Index  On-chain Usage
0..32      oldCommitment    [0]    Consumed from CommitmentKey dynamic field
32..64     newCommitment    [1]    Created as new CommitmentKey dynamic field
64..96     threshold        [2]    LE u64 at [64..72], upper [72..96] asserted zero
96..128    epochId          [3]    LE u64 at [96..104], upper [104..128] asserted zero
128..160   nullifier        [4]    Full 32 bytes stored as NullifierKey
160..192   txAmountHash     [5]    Not extracted on-chain (receiver-side verification)
```

## Security Properties

| Property | Mechanism | Error Code |
|----------|-----------|-----------|
| Amount privacy | Amounts never in public inputs; only Poseidon commitment hashes on-chain | -- |
| Sender privacy | No address in transfer events; commitments are pseudonymous | -- |
| Replay prevention | Nullifier stored in dynamic field after use (permanent) | E_NULLIFIER_SPENT (2) |
| UTXO integrity | Old commitment consumed, new commitment created atomically | E_COMMITMENT_CHAIN_BROKEN (9), E_COMMITMENT_EXISTS (10) |
| Overflow prevention | Num2Bits(64) on cumOld, txAmount, cumNew, and threshold independently | -- |
| Threshold enforcement | LessEqThan(64) in-circuit: cumNew <= threshold | -- |
| Epoch binding | Nullifier includes epochId from Clock; contract verifies match | E_EPOCH_MISMATCH (8) |
| Domain separation | Three Poseidon tags (1=commit, 2=nullifier, 3=amount); no cross-type collision | -- |
| Identity binding | Commitments include userSecret via Poseidon(4); prevents commitment theft | -- |
| VK integrity | sui::groth16 enforces gamma_g2 != delta_g2 internally | E_INVALID_PROOF (3) |
| VK update safety | 1-epoch timelock via propose_vk_update(); applied on next transfer | -- |
| Emergency stop | freeze_pool / unfreeze_pool via AdminCap; all functions check pool.frozen first | E_FROZEN (1) |
| AdminCap isolation | AdminCap.pool_id checked against pool.id on all admin operations | E_NOT_POOL_ADMIN (4) |
| Dust prevention | MIN_DEPOSIT = 1,000 base units (0.001 TOKEN) | E_DUST_DEPOSIT (11) |
| Amount correlation resistance | Standard deposit denominations only (100/500/1000 TOKEN) | E_NON_STANDARD_AMOUNT (14) |
| Upper bytes safety | Bytes [72..96] and [104..128] asserted zero for u64 public inputs | E_INVALID_INPUTS_LENGTH (7) |
| Trusted setup | Hermez Powers of Tau (pot15); production requires MPC ceremony | -- |

## Monorepo Structure

```
veil/
├── circuits/
│   ├── transfer.circom              # 11-constraint transfer circuit (v2)
│   ├── scripts/compile.sh           # Circom compilation + Groth16 setup
│   ├── test/transfer.test.mjs       # 40 circuit tests
│   └── build/                       # r1cs, wasm, zkey, vk.json
├── contracts/
│   ├── Move.toml
│   ├── Published.toml               # Testnet deployment record
│   ├── sources/
│   │   ├── pool.move                # Core: UTXO, transfer, deposit, admin
│   │   ├── verifier.move            # sui::groth16 BN254 wrapper
│   │   └── token.move               # VEIL token (6 decimals)
│   └── tests/pool_tests.move        # 37 Move tests
├── frontend/
│   ├── DESIGN.md                    # Design system (dark terminal aesthetic)
│   └── src/
│       ├── app/                     # Next.js 14 pages
│       ├── components/              # UI components (12 total)
│       ├── hooks/                   # 6 hooks: proof, transfer, pool, epoch, state, withdraw
│       └── lib/                     # proof-converter, constants, types, txHistory
├── scripts/
│   ├── init.sh                      # Monorepo dependency installer
│   └── src/
│       ├── e2e-test.ts              # Full E2E pipeline (10 steps)
│       ├── deploy.ts                # Contract deployment
│       ├── proof-converter.ts       # snarkjs to Sui bytes (G1/G2 compression)
│       └── test-converter.ts        # 109 converter tests
└── docs/
    ├── architecture.md              # This file
    ├── veil-architecture-report.html # Print-ready HTML report
    └── c4-*.html                    # Interactive C4 diagrams (4 levels)
```

## Development Commands

```bash
# Move contract
cd contracts && sui move build
cd contracts && sui move test

# ZK circuit
cd circuits && bash scripts/compile.sh
cd circuits && npm test

# Proof converter
cd scripts && bun run src/test-converter.ts

# End-to-end (testnet)
cd scripts && bun run src/e2e-test.ts

# Frontend
cd frontend && bun run dev
```

## Tier 3: Compliance Architecture (v3)

### Overview

Tier 3 extends Veil with a second ZK circuit (`compliance.circom`) that proves credential validity without revealing identity. A Tier 3 pool requires both a transfer proof (amounts hidden) and a compliance proof (KYC satisfied) in the same transaction.

```
┌──────────────────────────────────────────────────────────────────────┐
│                         USER BROWSER                                  │
│                                                                        │
│  VeilPrivateState (encrypted localStorage)                             │
│    + credentialSecret: bigint   // kept off-chain, never exposed       │
│    + kycLevel: number           // from issuer                         │
│    + credentialExpiry: number   // epoch at which credential expires   │
│                                                                        │
│  ┌────────────────────────┐   ┌──────────────────────────────────┐    │
│  │   TRANSFER PROOF        │   │   COMPLIANCE PROOF               │    │
│  │   (transfer.circom)     │   │   (compliance.circom)            │    │
│  │                         │   │                                  │    │
│  │   6 public inputs       │   │   6 public inputs:               │    │
│  │   (v2 -- unchanged)     │   │   • merkleRoot                   │    │
│  │                         │   │   • currentEpoch                 │    │
│  │   BN254 Groth16         │   │   • contextId (pool_id)          │    │
│  │   ~11 constraints       │   │   • requiredKycLevel             │    │
│  │                         │   │   • nullifier (tag 5)            │    │
│  │                         │   │   • validCredential (must = 1)   │    │
│  │                         │   │                                  │    │
│  │                         │   │   BN254 Groth16                  │    │
│  │                         │   │   ~7,200 constraints             │    │
│  └────────────┬────────────┘   └──────────────┬───────────────────┘    │
│               │                               │                        │
│               │    + auditor ciphertext        │                        │
│               │      (ECDH P-256 + AES-GCM)   │                        │
└───────────────┼───────────────────────────────┼────────────────────────┘
                │                               │
                └──────────────┬────────────────┘
                               │  compliant_transfer(pool, transfer_proof,
                               │    transfer_inputs, compliance_proof,
                               │    compliance_inputs, auditor_ciphertext, clock)
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│              SUI MOVE CONTRACT (veil::pool -- Tier 3)                 │
│                                                                        │
│  ComplianceConfig { pool_id, compliance_vk, credential_root,          │
│                     required_kyc_level, auditor_key }                  │
│                                                                        │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐ │
│  │  Transfer Proof   │  │ Compliance Proof  │  │  Auditor Ciphertext  │ │
│  │  Verification     │  │ Verification      │  │                      │ │
│  │  (veil::verifier) │  │ (veil::verifier)  │  │  ECDH P-256 +        │ │
│  │  sui::groth16     │  │  sui::groth16     │  │  AES-128-GCM         │ │
│  │  BN254 native     │  │  BN254 native     │  │  Bound to            │ │
│  └────────┬──────────┘  └────────┬──────────┘  │  txAmountHash        │ │
│           │                      │             └──────────────────────┘ │
│           │ both valid           │                                       │
│           └──────────┬───────────┘                                       │
│                      ▼                                                    │
│  ┌──────────────────────────────────────────┐                            │
│  │  State Transitions (atomic)               │                            │
│  │                                           │                            │
│  │  Transfer UTXO:                           │                            │
│  │    consume old commitment                 │                            │
│  │    store transfer nullifier               │                            │
│  │    create new commitment                  │                            │
│  │                                           │                            │
│  │  Compliance:                              │                            │
│  │    store credential nullifier             │                            │
│  │    (CredentialNullifierKey → bool)        │                            │
│  └──────────────────────────────────────────┘                            │
│                                                                           │
│  Error codes 20-26 (compliance-specific, see SPEC.md)                    │
└──────────────────────────────────────────────────────────────────────────┘
```

### Credential Lifecycle

```
ISSUANCE
  KYC Issuer
    ├── Verifies user identity off-chain
    ├── Assigns kycLevel (1=basic, 2=enhanced, 3=full)
    ├── Sets expiry epoch
    ├── Computes leaf = Poseidon(4, kycLevel, expiry, credentialSecret, contextId)
    └── Inserts leaf into Merkle tree; publishes new root on-chain

USER HOLDS
  credentialSecret: bigint   // from issuer, kept in encrypted localStorage
  kycLevel: number
  credentialExpiry: number   // epoch number

PROVING (per compliant transfer)
  User computes:
    leaf         = Poseidon(4, kycLevel, expiry, credentialSecret, contextId)
    nullifier    = Poseidon(5, credentialSecret, currentEpoch, contextId)
    Merkle proof = sibling path from leaf to merkleRoot
  Generates compliance Groth16 proof (private: leaf data + Merkle path)

ON-CHAIN VERIFICATION
  Contract checks:
    merkleRoot     == pool.credential_root
    contextId      == pool.id
    requiredKycLevel <= proven kycLevel
    validCredential == 1
    currentEpoch   == Clock epoch
    CredentialNullifierKey not already spent this epoch

EXPIRY
  Issuer publishes new Merkle root excluding expired credentials
  Admin calls update_credential_root(pool, cap, new_root)
  User must obtain a renewed credential from issuer
```

### Dual-Proof Flow (Compliant Transfer)

```
1. BROWSER
   ├── Load VeilPrivateState (transfer fields) + credential fields
   ├── Generate transfer proof  (Web Worker A, ~2s)
   │     transfer.circom — 6 public + 7 private inputs
   ├── Generate compliance proof (Web Worker B, ~3s)
   │     compliance.circom — 6 public + private Merkle path
   ├── Encrypt auditor payload (main thread, ~1ms)
   │     plaintext = { txAmount, salt, txAmountHash }
   │     ECDH ephemeral P-256 key + AES-128-GCM
   │     auditorCiphertext = ephemeralPubKey || iv || tag || ciphertext
   └── Convert both proofs to Sui bytes (proof-converter.ts)

2. SUI TRANSACTION
   └── pool::compliant_transfer(
         pool, transfer_proof, transfer_inputs,
         compliance_proof, compliance_inputs,
         auditor_ciphertext, clock
       )
         ├── Verify transfer proof  → E_INVALID_PROOF (3)
         ├── Verify compliance proof → E_INVALID_CREDENTIAL (21)
         ├── Check merkleRoot match  → E_INVALID_MERKLE_ROOT (25)
         ├── Check contextId == pool.id
         ├── Check validCredential == 1 → E_INVALID_CREDENTIAL (21)
         ├── Check epoch match       → E_EPOCH_MISMATCH (8)
         ├── Check requiredKycLevel  → E_KYC_LEVEL_TOO_LOW (23)
         ├── Check credential nullifier not spent → E_CREDENTIAL_NULLIFIER_SPENT (24)
         ├── Store credential nullifier
         ├── Execute UTXO transfer (consume old, store nullifier, create new)
         └── event::emit(CompliantTransferEvent { nullifier, new_commitment })
           // auditor_ciphertext logged off-chain; not stored in contract state

3. BROWSER (after tx confirmed)
   ├── Update VeilPrivateState (cumulativeSpending, randomness)
   └── Persist to encrypted localStorage
```
