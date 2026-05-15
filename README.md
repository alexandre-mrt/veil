# Veil -- Private Payments on Sui

> Confidential compliance proofs on Sui. Amounts hidden. Threshold enforced. Zero-knowledge.

## The Problem

Every blockchain transaction is transparent by default. Amounts, senders, and receivers are permanently visible to anyone reading the chain. This creates a paradox: the technology that promises financial sovereignty also delivers total financial surveillance. For payments -- where privacy is not a luxury but a basic expectation -- this is a fundamental limitation.

Existing privacy solutions force a binary choice. Fully anonymous protocols (Tornado Cash, Zcash shielded pools) hide everything, creating regulatory risk and enabling illicit use. Fully transparent systems (standard ERC-20 transfers, Sui token moves) provide no privacy at all. There is nothing in between -- no protocol that hides transaction amounts while still enforcing spending limits, allowing regulators to set thresholds without requiring identity disclosure below them.

## The Solution

Veil introduces **cumulative spending proofs** -- a novel ZK primitive that:

- Hides transaction amounts using Poseidon commitments bound to user identity
- Enforces KYC-free spending limits (FINMA CHF 1,000/30 days) in zero-knowledge
- Uses UTXO-style commitment consumption to prevent parallel chain attacks
- Standardizes deposit denominations (100/500/1000 TOKEN) to resist amount correlation

## How It Works

```
User: send 100 VEIL anonymously
  |
  v
[Browser — snarkjs WASM, ~2s]
  Compute Poseidon hashes (circomlibjs)
  Generate Groth16 proof (11 constraints)
  Prove: cumNew = cumOld + 100
         cumNew <= threshold
         nullifier is unique to this transfer
         commitments bound to userSecret
  |
  v
[Sui Move — veil::pool]
  Verify proof: sui::groth16 BN254 native
  Consume old commitment (UTXO-style)
  Check nullifier not already spent
  Store nullifier + create new commitment
  Emit TransferEvent (no amounts, no identity)
```

### The Circuit (11 constraints)

| # | Constraint | Component |
|---|-----------|-----------|
| C1 | `oldCommitment == Poseidon(1, cumOld, randOld, userSecret)` | Poseidon(4) |
| C2 | `newCommitment == Poseidon(1, cumNew, randNew, userSecret)` | Poseidon(4) |
| C3 | `cumNew == cumOld + txAmount` | Addition |
| C4 | `txAmount > 0` | GreaterThan(64) |
| C5 | `cumulativeOld in [0, 2^64)` | Num2Bits(64) |
| C6 | `txAmount in [0, 2^64)` | Num2Bits(64) |
| C7 | `cumulativeNew in [0, 2^64)` | Num2Bits(64) |
| C8 | `threshold in [0, 2^64)` | Num2Bits(64) |
| C9 | `cumNew <= threshold` | LessEqThan(64) |
| C10 | `nullifier == Poseidon(2, userSecret, epochId, randOld)` | Poseidon(4) |
| C11 | `txAmountHash == Poseidon(3, txAmount, salt)` | Poseidon(3) |

### Compliant Transfer (Tier 3)

Tier 3 pools require a second ZK proof alongside the transfer proof. The compliance circuit (`compliance.circom`) proves that the user holds a valid, unexpired KYC credential in a Merkle tree without revealing which credential or any identity information.

```
User: send 100 VEIL to a Tier 3 pool
  |
  v
[Browser — parallel Web Workers]
  Transfer proof (~2s):  proves cumNew <= threshold, nullifier unique
  Compliance proof (~3s): proves KYC credential in Merkle tree, not expired
  Auditor ciphertext:    ECDH P-256 + AES-128-GCM, bound to txAmountHash
  |
  v
[Sui Move — veil::pool::compliant_transfer]
  Verify transfer proof (veil::verifier, BN254)
  Verify compliance proof (veil::verifier, BN254)
  Check merkleRoot matches pool credential_root
  Check credential nullifier not already spent
  Execute UTXO state transition (identical to standard transfer)
```

The credential nullifier (`Poseidon(5, credentialSecret, epoch, contextId)`) prevents double-use within an epoch without linking uses across epochs. The auditor ciphertext is logged off-chain; no identity data is stored in contract state.

### On-Chain Verification

- Groth16 BN254 via `sui::groth16` native verifier
- **UTXO-style**: old commitment consumed (removed), new commitment created
- Epoch + threshold validated against on-chain Clock and pool config
- Upper 24 bytes zero-checked for u64 public inputs (overflow protection)
- Dynamic field nullifier tracking (no Table contention)
- Standard deposit denominations: 100, 500, 1000 TOKEN (amount correlation resistance)
- **Tier 3**: dual Groth16 verification (transfer + compliance) in a single transaction

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                      USER BROWSER                              │
│                                                                │
│  VeilPrivateState (encrypted localStorage)                     │
│    userSecret, cumulativeSpending, randomness, currentEpoch    │
│                                                                │
│  [snarkjs WASM]  ──>  Groth16 proof  ──>  [proof-converter]   │
│    ~2s proving          11 constraints      arkworks bytes     │
└────────────────────────┬───────────────────────────────────────┘
                         │  proof_bytes + public_inputs_bytes
                         v
┌────────────────────────────────────────────────────────────────┐
│              SUI MOVE CONTRACT (veil::pool)                     │
│                                                                │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │  Groth16     │  │  Nullifier   │  │  UTXO Commitments     │ │
│  │  Verifier    │  │  Set         │  │                       │ │
│  │              │  │              │  │  Old: consumed         │ │
│  │  BN254       │  │  dynamic     │  │  New: created          │ │
│  │  native      │  │  fields      │  │  dynamic fields        │ │
│  └──────────────┘  └──────────────┘  └───────────────────────┘ │
│                                                                │
│  Pool { balance, transfer_vk, threshold, frozen }              │
│  AdminCap { pool_id } — bound to specific pool                 │
│                                                                │
│  Functions:                                                    │
│    deposit_and_register | deposit | shielded_transfer           │
│    withdraw (AdminCap) | freeze/unfreeze | propose_vk_update   │
│                                                                │
│  Standard deposits: 100 | 500 | 1000 TOKEN                    │
└────────────────────────────────────────────────────────────────┘
```

## Security

### Iterative security review (per review pass)

- **Loop 1**: 92 findings, 16 critical fixes (commitment chain, VK timelock, AdminCap binding)
- **Loop 2**: 24 findings, UTXO model, frontend v2 hashes, anti-griefing deposit
- **Loop 3**: 5 findings, UTXO verified correct, E2E updated
- **Loop 4**: CLEAN -- 0 critical, 0 high, 0 medium

### Privacy Red Team (15 findings)

- Identified protocol as "confidential compliance system" (amounts hidden, sender visible)
- Applied standard deposit denominations to resist amount correlation
- Documented relayer requirement for full sender privacy

### Test Coverage

| Layer | Tests | Coverage |
|-------|-------|---------|
| Move contract | 50 | Every function, every error code, compliance config, admin isolation |
| Circom circuit (transfer) | 40 | Every constraint (C1-C11), boundaries, domain separation |
| Proof converter | 109 | bigintToLE32, G1/G2 compression, sign bits, VK layout |
| Compliance utils | 67 | Credential leaf, nullifier, Merkle tree builder, depth-20 proofs |
| E2E compliance (real Groth16) | 32 | Dual proofs, ECDH encryption, expired/low-KYC, no mocks |
| **Total** | **298** | **0 failures** |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| ZK Circuits | Circom 2.1 + snarkjs 0.7 (BN254 Groth16) |
| Smart Contract | Sui Move 2024 |
| On-chain Verifier | `sui::groth16` native (BN254) |
| Frontend | Next.js 14 + @mysten/dapp-kit |
| Client Proving | snarkjs WASM (Web Worker) |
| Token | Custom VEIL (6 decimals, TreasuryCap + faucet) |
| Documentation | C4 diagrams + HTML report |

## Quick Start

```bash
git clone https://github.com/alexandre-mrt/veil
cd veil && bash scripts/init.sh

# Build and test the Move contract
cd contracts && sui move build && sui move test       # 37/37 pass

# Compile the ZK circuit and run tests
cd ../circuits && bash scripts/compile.sh && npm test  # 40/40 pass

# Run proof converter tests
cd ../scripts && bun run src/test-converter.ts         # 109/109 pass

# Start the frontend
cd ../frontend && bun run dev                          # localhost:3000
```

**Prerequisites:** `circom` 2.1.x, `snarkjs` 0.7.x, `sui` CLI (testnet), `bun`

## E2E Verified on Testnet

```
Package: 0xd0598d2256bfa33b8324bc6316cee1118f9131cdde346f8f1f757adb594a66bb
Network: testnet (chain-id 4c78adac)
Nullifier replay: correctly rejected (abort code 2 or 9)
```

## Project Structure

```
veil/
├── circuits/
│   ├── transfer.circom              # 11-constraint transfer circuit (v2)
│   ├── scripts/compile.sh           # Circom compilation + Groth16 trusted setup
│   └── test/transfer.test.mjs       # 40 constraint tests (happy + violation + edge)
├── contracts/
│   ├── sources/
│   │   ├── pool.move                # Core: deposit, transfer, withdraw, UTXO model
│   │   ├── verifier.move            # sui::groth16 BN254 wrapper
│   │   └── token.move               # VEIL token (6 decimals, TreasuryCap + faucet)
│   └── tests/pool_tests.move        # 37 tests (happy path, errors, edge cases)
├── frontend/
│   ├── src/app/                     # Next.js 14 App Router
│   ├── src/components/              # UI: deposit, transfer, withdraw, privacy status
│   ├── src/hooks/                   # useProofGeneration, useShieldedTransfer, useVeilPool
│   └── src/lib/                     # proof-converter, constants, types
├── scripts/
│   ├── src/e2e-test.ts              # Full pipeline: compile, prove, deploy, verify
│   ├── src/proof-converter.ts       # snarkjs JSON to Sui arkworks bytes
│   ├── src/test-converter.ts        # 109 converter tests
│   └── src/deploy.ts                # Contract deployment helper
└── docs/
    ├── architecture.md              # Full architecture description
    ├── veil-architecture-report.html # Print-ready HTML report
    └── c4-*.html                    # Interactive C4 diagrams
```

## Novel Contributions

1. **Cumulative spending proofs** -- first implementation on any chain
2. **UTXO commitment consumption** -- prevents parallel chain attacks
3. **Poseidon(4) identity-bound commitments** -- commitments tied to userSecret
4. **Note-based nullifiers** -- multiple transfers per epoch (not one)
5. **Standard deposit denominations** -- resists amount correlation analysis
6. **iterative security review** with reviewers
7. **Dual-proof compliant transfers** -- transfer proof + compliance proof verified atomically on-chain
8. **Epoch-scoped credential nullifiers** -- prove KYC once per epoch without linking epochs

## Known Limitations (Documented)

- Sender address visible on Sui transactions (needs relayer for full privacy)
- UTXO chain traceable via transaction effects (needs Merkle accumulator)
- Trusted setup uses single contributor (needs MPC ceremony for mainnet)
- Admin can drain pool via withdraw (needs ZK-proof-gated redemption)
- Tier 3 credential Merkle root update is admin-gated; revocation latency = time between root updates
- Auditor ciphertext is logged off-chain only; on-chain auditability requires an indexer

## Track

Sui Overflow 2026 -- DeFi & Payments

## License

MIT
