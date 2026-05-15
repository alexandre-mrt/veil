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
| Move contract | 79 | Every function, every error code, compliance config, admin isolation, 19 attacker threat scenarios |
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
| Frontend | Next.js 14 + @mysten/dapp-kit-react v2 (gRPC) |
| Client Proving | snarkjs WASM (Web Worker) |
| Token | Custom VEIL (6 decimals, TreasuryCap + faucet) |
| Documentation | C4 diagrams + HTML report |

## Quick Start

```bash
git clone https://github.com/alexandre-mrt/veil
cd veil && bash scripts/init.sh

# Build and test the Move contract
cd contracts && sui move build && sui move test       # 79/79 pass

# Compile the ZK circuit and run tests
cd ../circuits && bash scripts/compile.sh && npm test  # 40/40 pass

# Run proof converter tests
cd ../scripts && bun run src/test-converter.ts         # 109/109 pass

# Start the frontend
cd ../frontend && bun run dev                          # localhost:3000
```

**Prerequisites:** `circom` 2.1.x, `snarkjs` 0.7.x, `sui` CLI (testnet), `bun`

## Live on Testnet

**Frontend:** https://frontend-sepia-nine-30.vercel.app

| Object | ID |
|--------|----|
| Package | `0x468e707669e33ef8664fd0f25fb16ee86623feab98254cc9c22044e79a371737` |
| Pool | `0x9b8e6bb7f09a483d8ec50c91f9e9f64a1d91bac64706afe56653c46a1ed720ba` |
| ComplianceConfig | `0x5999ace2cfcc952dc66dce83b3314930e435f99ee49abc11972871b5ecf5ed29` |
| TreasuryCap | `0xf2b51f2995dc8fdebb0342cabc3d162b7159a91cda2ecb1d1b46988129e366d2` |

Network: testnet (chain-id `4c78adac`), 1-hour epochs, compliance required

## Demo Walkthrough (Judges)

### 1. Connect & Fund
1. Open https://frontend-sepia-nine-30.vercel.app/dashboard
2. Connect a Sui testnet wallet (Sui Wallet, Suiet, etc.)
3. Click **+ FAUCET** to mint 1000 VEIL test tokens

### 2. Anonymous Deposit
1. In the **Deposit** tab, select a denomination (100, 500, or 1000 VEIL)
2. Click **Deposit & Register** -- this computes a Poseidon commitment client-side and submits a PTB
3. Watch the "Shielded Balance" card update in the balance display
4. Check the tx on Suiscan via the link

### 3. Anonymous Transfer (Below Threshold)
1. Switch to the **Transfer** tab
2. Enter an amount (e.g., 50 VEIL) -- the threshold progress bar shows your cumulative spending
3. Click **Shielded Transfer** -- a Groth16 proof is generated in-browser (~2s)
4. Watch the 5-step progress indicator: commitment, proof, nullifier, submit, confirm
5. The transfer consumes the old UTXO commitment and creates a new one

### 4. Hit the Threshold
1. Make multiple transfers until cumulative spending approaches 1000 VEIL
2. At 70%, a yellow warning appears: "KYC may be required soon"
3. At 100%, the transfer is blocked: "Threshold exceeded"

### 5. Compliant Transfer (Above Threshold)
1. In the sidebar, open **Credential Manager** and click **[Demo] Generate Test Credential**
2. Switch to the **Compliant Transfer** tab
3. Select your credential from the dropdown
4. Enter an amount and submit
5. Two Groth16 proofs are generated (transfer + compliance), the amount is encrypted for the auditor via ECDH P-256, and the PTB is submitted

### 6. Verify On-Chain
- All transfers emit privacy-preserving events (no amounts, no addresses)
- `ComplianceVerifiedEvent` contains the auditor-encrypted amount
- Pool balance is verifiable on Suiscan: search for the Pool ID above

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
