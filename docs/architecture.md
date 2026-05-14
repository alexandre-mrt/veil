# Veil — Architecture

## Overview

Veil is a privacy payment protocol on Sui. It combines Circom ZK circuits with native Sui Groth16 verification to let users transact anonymously below a regulatory threshold, and prove KYC compliance above it — without revealing amounts or identity.

## System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         USER WALLET                                   │
│  (zkLogin onboarding, private state encrypted in localStorage)        │
│                                                                        │
│  VeilPrivateState {                                                    │
│    userSecret: bigint      // master secret, never leaves browser      │
│    currentEpoch: number    // from on-chain Clock                      │
│    cumulativeSpending: bigint                                          │
│    randomness: bigint      // blinding factor for commitment           │
│  }                                                                     │
└──────────┬────────────────────────────────────┬───────────────────────┘
           │                                    │
    amount < CHF 1,000/epoch           amount >= CHF 1,000/epoch
           │                                    │
           ▼                                    ▼
┌──────────────────────┐           ┌────────────────────────────────┐
│   TRANSFER PROOF      │           │  TRANSFER + COMPLIANCE PROOF   │
│   (transfer.circom)   │           │  (transfer.circom +            │
│                       │           │   compliance.circom)           │
│   6 public inputs:    │           │                                │
│   • oldCommitment     │           │   6 + 4 public inputs:         │
│   • newCommitment     │           │   • all transfer inputs        │
│   • threshold         │           │   • credential_root (Merkle)   │
│   • epochId           │           │   • nullifier_hash             │
│   • nullifier         │           │   • current_time               │
│   • txAmountHash      │           │   • min_kyc_level              │
│                       │           │                                │
│   ~1,250 constraints  │           │   ~8,450 constraints           │
│   BN254 Groth16       │           │   BN254 Groth16                │
│   snarkjs WASM        │           │   snarkjs WASM                 │
│   (~2s browser)       │           │   (~8s browser)                │
└──────────┬───────────┘           └───────────────┬────────────────┘
           │                                        │
           └────────────────────┬───────────────────┘
                                │
                    proof_bytes + public_inputs_bytes
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  SUI MOVE CONTRACT (veil::pool)                       │
│                                                                        │
│  ┌─────────────────────┐   ┌──────────────────┐   ┌───────────────┐  │
│  │   veil::verifier     │   │  Nullifier Set   │   │  Commitment   │  │
│  │                      │   │                  │   │    Store      │  │
│  │  sui::groth16        │   │  dynamic_field   │   │               │  │
│  │  (BN254 native)      │   │  NullifierKey    │   │  dynamic_field│  │
│  │  prepare_vk()        │   │  → bool          │   │  CommitmentKey│  │
│  │  verify_proof()      │   │                  │   │  → bytes      │  │
│  └──────────┬──────────┘   └──────────────────┘   └───────────────┘  │
│             │                                                          │
│             │ valid proof                                              │
│             ▼                                                          │
│  ┌─────────────────────┐   ┌──────────────────┐   ┌───────────────┐  │
│  │   Shielded Pool      │   │   Epoch Mgmt     │   │    Freeze     │  │
│  │                      │   │                  │   │   Mechanism   │  │
│  │  Balance<TOKEN>      │   │  Clock object    │   │               │  │
│  │  deposit()           │   │  epoch_id =      │   │  AdminCap     │  │
│  │  withdraw()          │   │  ts_ms / 30days  │   │  frozen: bool │  │
│  └─────────────────────┘   └──────────────────┘   └───────────────┘  │
│                                                                        │
│  Entry functions: deposit | shielded_transfer | withdraw | freeze     │
│  Error codes: E_FROZEN(1) | E_NULLIFIER_SPENT(2) | E_INVALID_PROOF(3)│
└──────────────────────────────────────────────────────────────────────┘
```

## Circuit Architecture

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

CONSTRAINTS (9 total, ~1,250 R1CS):

[1] oldCommitment == Poseidon(1, cumulativeOld, randomnessOld)
[2] newCommitment == Poseidon(1, cumulativeNew, randomnessNew)
[3] cumulativeNew == cumulativeOld + txAmount
[4] txAmount > 0              (GreaterThan(64))
[5] cumulativeOld in [0, 2^64)  (Num2Bits(64))
[6] txAmount in [0, 2^64)       (Num2Bits(64))
[7] cumulativeNew in [0, 2^64)  (Num2Bits(64))
[8] nullifier == Poseidon(2, userSecret, epochId)
[9] txAmountHash == Poseidon(txAmount, salt)

Domain separation:
  tag 1 → commitment hashes  H(1, cumulative, randomness)
  tag 2 → nullifier hashes   H(2, userSecret, epochId)
```

### compliance.circom (stretch goal, ~7,200 constraints)

```
PUBLIC INPUTS (4)                    PRIVATE INPUTS (5)
─────────────────                    ──────────────────
credential_root                      credential_leaf
nullifier_hash    ──────────────►    merkle_proof[20]
current_time      CONSTRAINTS        userSecret
min_kyc_level                        kyc_level
                                     expiry

CONSTRAINTS:
[1] credential_leaf = Poseidon(userSecret, kyc_level, expiry)
[2] MerkleProof(credential_leaf, merkle_proof) == credential_root
[3] kyc_level >= min_kyc_level
[4] expiry > current_time
[5] nullifier_hash == Poseidon(3, userSecret, credential_root)
```

## Transaction Flow

### Shielded Transfer (below threshold)

```
1. BROWSER
   ├── Load VeilPrivateState from encrypted localStorage
   ├── Compute Poseidon hashes (circomlibjs)
   │     oldCommitment = Poseidon(1, cumulativeOld, randomnessOld)
   │     newCommitment = Poseidon(1, cumulativeOld + amount, randomnessNew)
   │     nullifier     = Poseidon(2, userSecret, epochId)
   │     txAmountHash  = Poseidon(amount, salt)
   ├── Generate Groth16 proof (snarkjs WASM in Web Worker)
   └── Convert proof to Sui byte format (proofToSuiBytes, publicInputsToSuiBytes)

2. SUI TRANSACTION
   └── pool::shielded_transfer(pool, proof_bytes, public_inputs_bytes, clock)
         |
         ├── assert!(!pool.frozen)
         ├── verifier::verify_transfer_proof(vk, proof, inputs)
         │     └── sui::groth16::verify_groth16_proof(&bn254(), ...)
         ├── Extract nullifier from public_inputs_bytes[128..160]
         ├── assert! nullifier not in dynamic_field set
         ├── dynamic_field::add(nullifier_key -> true)
         ├── Extract new_commitment from public_inputs_bytes[32..64]
         ├── dynamic_field::add(commitment_key -> new_commitment)
         └── event::emit(TransferEvent { nullifier, new_commitment })

3. BROWSER (after tx confirmed)
   ├── Update cumulativeSpending += amount
   ├── Update randomness = randomnessNew
   └── Persist VeilPrivateState to encrypted localStorage
```

### Deposit

```
User → pool::deposit(pool, Coin<TOKEN>)
         ├── assert!(!pool.frozen)
         ├── balance::join(&mut pool.balance, coin.into_balance())
         └── event::emit(DepositEvent { sender, amount })
```

### Withdraw

```
User → pool::withdraw(pool, amount, recipient)
         ├── assert!(!pool.frozen)
         ├── assert!(pool.balance.value() >= amount)
         ├── coin::from_balance(balance::split(..., amount))
         └── transfer::public_transfer(coin, recipient)
```

## Epoch Design

```
Timeline:
│────────────────────────────────────────────────────────
│  Epoch 0          │  Epoch 1          │  Epoch 2
│  [0, 30 days)     │  [30, 60 days)    │  [60, 90 days)
│
│  Genesis commitment: Poseidon(1, 0, 0)
│  Nullifier:          Poseidon(2, userSecret, 0)
│
│                   │ Epoch boundary
│                   │  New genesis:    Poseidon(1, 0, 0)   (same)
│                   │  New nullifier:  Poseidon(2, userSecret, 1)
│                   │  cumulativeOld reset to 0
│
│  epoch_id = Clock::timestamp_ms() / EPOCH_DURATION_MS
│  EPOCH_DURATION_MS = 2_592_000_000  (30 days in ms)
```

## Public Input Byte Layout

The Sui verifier reads public inputs as a flat byte array. Each input is 32 bytes (big-endian field element).

```
Offset   Field
0..32    oldCommitment       (index 0)
32..64   newCommitment       (index 1)
64..96   threshold           (index 2)
96..128  epochId             (index 3)
128..160 nullifier           (index 4) ← pool extracts this for replay check
160..192 txAmountHash        (index 5)
```

## Security Properties

| Property | Mechanism |
|----------|-----------|
| Amount privacy | Never in public inputs; only commitment hashes on-chain |
| Sender privacy | No address in transfer; commitments are pseudonymous |
| Replay prevention | Nullifier stored in dynamic field after use (E_NULLIFIER_SPENT) |
| Overflow prevention | Num2Bits(64) on old, tx, and new values independently |
| Epoch binding | nullifier = Poseidon(2, userSecret, epochId); epochId from Clock |
| Domain separation | Commitment tag 1, nullifier tag 2 — no cross-type collision |
| VK integrity | sui::groth16 enforces gamma_g2 != delta_g2 internally |
| Emergency stop | freeze_pool / unfreeze_pool via AdminCap |
| Trusted setup | Hermez Powers of Tau (pot15); dev contribution for testing |

## Monorepo Structure

```
veil/
├── circuits/
│   ├── transfer.circom              # Main privacy circuit
│   ├── scripts/compile.sh           # Compilation + Groth16 setup
│   ├── test/transfer.test.mjs       # Constraint tests
│   └── build/                       # r1cs, wasm, zkey, vk.json
├── contracts/
│   ├── Move.toml
│   └── sources/
│       ├── pool.move                # Protocol core
│       ├── verifier.move            # sui::groth16 wrapper
│       └── token.move               # VEIL token
├── frontend/
│   └── src/
│       ├── app/                     # Next.js pages (page.tsx, dashboard)
│       ├── components/              # UI components
│       ├── hooks/                   # useProof, useWallet, useVeilState
│       └── lib/                     # snarkjs helpers, state management
└── scripts/
    ├── init.sh
    └── src/
        ├── e2e-test.ts              # End-to-end pipeline
        ├── deploy.ts                # Contract deployment
        └── proof-converter.ts       # snarkjs → Sui bytes
```

## Development Commands

```bash
# Move contract
cd contracts && sui move build
cd contracts && sui move test

# ZK circuit
cd circuits && bash scripts/compile.sh   # compile + trusted setup
cd circuits && npm test                  # test constraints

# End-to-end (testnet)
cd scripts && bun run src/e2e-test.ts

# Frontend
cd frontend && bun run dev
```
