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

> **[Interactive Protocol Flow Diagram](docs/protocol-flow.html)** -- visual architecture with animated flows, expandable circuit details, and compliance path breakdown.
>
> **[Demo Guide](docs/demo-showcase.html)** -- step-by-step walkthrough with screenshots and what to look for at each stage.

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

The credential nullifier (`Poseidon(5, userSecret, contextId)` where `contextId = Poseidon(6, transferNullifier, userSecret)`) is unique per transfer, preventing compliance proof replay without linking uses across transfers. The auditor ciphertext is emitted via `ComplianceVerifiedEvent`; no identity data is stored in contract state.

### Withdraw Circuit (9 constraints)

Users can exit the pool without admin involvement via a ZK withdrawal proof. Partial withdrawal creates a change commitment for the remaining balance.

| # | Constraint | Component |
|---|-----------|-----------|
| C1 | `commitment == Poseidon(1, cumulativeOld, randomnessOld, userSecret)` | Poseidon(4) |
| C2 | `withdrawAmount in [0, 2^64)` | Num2Bits(64) |
| C3 | `withdrawAmount > 0` | GreaterThan(64) |
| C4 | `cumulativeOld in [0, 2^64)` | Num2Bits(64) |
| C5 | `withdrawAmount <= cumulativeOld` | LessEqThan(64) |
| C6 | `newCommitment == Poseidon(1, remainingBalance, randomnessNew, userSecret)` | Poseidon(4) |
| C7 | `remainingBalance in [0, 2^64)` | Num2Bits(64) |
| C8 | `nullifier == Poseidon(7, userSecret, randomnessOld, cumulativeOld)` | Poseidon(4) |
| C9 | `recipientHash == Poseidon(8, recipient)` | Poseidon(2) |

Domain tags 7 (withdrawal nullifier) and 8 (recipient binding) prevent front-running and redirect attacks. The recipient hash ties the withdrawal to a specific Sui address, verified on-chain.

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
│  Pool { balance, transfer_vk, threshold, frozen,               │
│         commitment_root, next_leaf_index }                      │
│  AdminCap { pool_id } — bound to specific pool                 │
│  MultisigConfig { signers, required_approvals }                │
│                                                                │
│  Functions:                                                    │
│    deposit_and_register | shielded_transfer                     │
│    zk_withdraw | emergency_withdraw | freeze/unfreeze          │
│    propose_vk_update | update_commitment_root                  │
│                                                                │
│  Merkle accumulator: depth-20 Poseidon tree, root on-chain    │
│  Standard deposits: 100 | 500 | 1000 TOKEN                    │
└────────────────────────────────────────────────────────────────┘
```

## Security

**Final Grade: 142/165 (86%) -- STRONG** (see `docs/final-grade-report.md`)

**Formal threat model**: see `docs/threat-model.md` (STRIDE methodology, 7 spoofing + 7 tampering + 4 repudiation + 6 information disclosure + 6 DoS + 7 elevation of privilege threats analyzed).

**Multi-sig governance**: opt-in N-of-M signer approval for admin operations (freeze/unfreeze). See `multisig.move`.

### 5-Loop Deep Audit

- **Loop 1**: 92 findings, 16 critical fixes (commitment chain, VK timelock, AdminCap binding)
- **Loop 2**: 24 findings, UTXO model, frontend v2 hashes, anti-griefing deposit
- **Loop 3**: 5 findings, UTXO verified correct, E2E updated
- **Loop 4**: CLEAN -- 0 critical, 0 high, 0 medium
- **Loop 5**: 11 specialized agents (access control, arithmetic, crypto/identity, cross-protocol, DeFi economics, flash loans, infra/ops, object model, oracle/timing, type safety, persona flows) -- see `docs/loop5-audit-report.md`

### Loop 5 Audit Summary (11 agents)

| Agent | Risk | Key Findings |
|-------|------|-------------|
| Access Control | LOW | AdminCap isolation correct, all 19 admin functions gated |
| Arithmetic | LOW | `requiredKycLevel` 8-bit wraparound in circuit (on-chain backstop) |
| Crypto & Identity | MEDIUM | Domain separation sound, nullifier uniqueness verified |
| Cross-Protocol | MEDIUM | UpgradeCap unsecured, fake ComplianceConfig defense fragile |
| DeFi Economics | HIGH | Admin withdrawal uncapped, Sybil on spending limits, no user withdrawal |
| Flash Loans | MEDIUM | All flash loan vectors blocked by commitment maturity check |
| Infra & Ops | HIGH | Trusted setup dev-only, relayer open CORS, UpgradeCap in EOA |
| Object Model | MEDIUM | AdminCap `store` wrapping risk, no object destruction functions |
| Oracle & Timing | MEDIUM | E2E test epoch mismatch, Date.now() vs Clock desync |
| Type Safety | MEDIUM | `pool_uid_mut` access surface, type system sound overall |
| Persona Flows | MEDIUM | userSecret in localStorage, emergency withdraw no timelock |

**Aggregate: 3 critical (infra), 5 high, 15 medium, 25 low, 20 info -- 68 total findings (deduplicated from 11 agents)**

### SOTA Comparison

| Protocol | Compliance | Anonymity Set | Proving System |
|----------|-----------|---------------|----------------|
| Tornado Cash | None (sanctioned) | Merkle depth-20 | Groth16 BN254 |
| Zcash Orchard | Viewing keys only | Global tree | Halo 2 (trustless) |
| Railgun | Proof of Innocence (negative) | Merkle accumulator | Groth16 |
| Penumbra | None | Multi-asset pool | Decaf377 |
| **Veil** | **Dual-proof KYC + auditor encryption** | **Merkle depth-20** | **Groth16 BN254** |

Veil's compliance system is unique: dual Groth16 proofs (transfer + KYC credential) verified atomically, with ECDH-encrypted amounts for auditor access. No other protocol combines threshold-based anonymous transfers with positive KYC proofs.

### Pre-Mainnet Blockers (from Loop 5)

1. **UpgradeCap**: transfer to multisig or burn (`sui::package::make_immutable`)
2. **Trusted setup**: run multi-party ceremony (minimum 3 contributors)
3. **Relayer**: restrict CORS, add rate limiting, validate TransactionKind
4. **EPOCH_DURATION_MS**: change to `2_592_000_000` (30 days) before mainnet deploy
5. **Faucet function**: remove `token::faucet()` from production bytecode

### Privacy Red Team (15 findings)

- Identified protocol as "confidential compliance system" (amounts hidden, sender visible)
- Applied standard deposit denominations to resist amount correlation
- Relayer pattern implemented for sender privacy

### Test Coverage

| Layer | Tests | Coverage |
|-------|-------|---------|
| Move contract | 124 | Every function, every error code, 9 timelocks, 19 attacker threats, 10 negative-validation, multisig |
| Circom circuit (transfer) | 40 | Every constraint (C1-C11), boundaries, domain separation |
| Circom circuit (compliance) | 30 | Credential validity, Merkle proof, context binding, nullifier uniqueness, range proofs |
| Circom circuit (withdraw) | 30 | Commitment ownership, overdraw, zero-amount, nullifier derivation, recipient binding |
| Proof converter | 109 | bigintToLE32, G1/G2 compression, sign bits, VK layout |
| Compliance utils | 67 | Credential leaf, nullifier, Merkle tree builder, depth-20 proofs |
| E2E compliance (real Groth16) | 32 | Dual proofs, ECDH encryption, expired/low-KYC, no mocks |
| Frontend (vitest) | 19 | requireEnv logic, AES-GCM encrypt/decrypt roundtrip, key isolation, corruption detection, wallet key derivation |
| Fuzz (fast-check) | 6x500 | Commitment determinism, nullifier uniqueness, overflow, Merkle soundness, domain separation, credential validity |
| **Total** | **454+** | **0 failures** |

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
cd contracts && sui move build && sui move test       # 124/124 pass

# Compile the ZK circuit and run tests
cd ../circuits && bash scripts/compile.sh && npm test  # 100/100 pass (transfer 40 + compliance 30 + withdraw 30)

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
| Package | `0x5cd79f85f1adca022513d76c60d557f8b17afed91f741d14016c7a23cab6c228` |
| Pool | `0x6ba8019987c7c5d02d2c2b11e0eddd491428d0cc6bbed05ab79760e069ce913a` |
| ComplianceConfig | `0xa6c92b963d9b67896416ae2eb23f0fadbbc62e90fba6ca18db5f96b6bc4f63c7` |
| TreasuryCap | `0xdc0f16084cbd2d33d1fc3630e80bac565469550e93c5e147a7d9c04fa4a3058f` |

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
│   ├── compliance.circom            # ~7200-constraint KYC compliance circuit (Merkle depth 20)
│   ├── withdraw.circom              # 9-constraint withdrawal circuit (partial withdraw, recipient-bound)
│   ├── templates/merkle_proof.circom # Poseidon Merkle proof template
│   ├── scripts/compile.sh           # Transfer circuit compilation + Groth16 trusted setup
│   ├── scripts/compile-compliance.sh # Compliance circuit compilation + setup
│   └── test/
│       ├── transfer.test.mjs        # 40 constraint tests (happy + violation + edge)
│       ├── compliance.test.mjs      # 30 compliance circuit tests (credential, Merkle, nullifier)
│       └── withdraw.test.mjs        # 30 withdraw circuit tests (ownership, overdraw, recipient)
├── contracts/
│   ├── sources/
│   │   ├── pool.move                # Core: deposit, transfer, withdraw, UTXO model, Merkle accumulator
│   │   ├── compliance.move          # Tier 3: KYC compliance, credential root, auditor key
│   │   ├── verifier.move            # sui::groth16 BN254 wrapper (transfer + compliance + withdraw)
│   │   ├── token.move               # VEIL token (6 decimals, TreasuryCap)
│   │   ├── multisig.move            # N-of-M multi-sig governance for admin operations
│   │   └── token_faucet.move        # Testnet-only faucet (remove before mainnet)
│   └── tests/                       # 124 tests (pool, compliance, scenario/threat, multisig)
├── frontend/
│   ├── src/app/                     # Next.js 14 App Router
│   ├── src/components/              # UI: deposit, transfer, withdraw, privacy status
│   ├── src/hooks/                   # useProofGeneration, useShieldedTransfer, useCompliantTransfer, useSponsoredTransaction
│   └── src/lib/                     # proof-converter, relayer client, constants, types
├── scripts/
│   ├── src/relayer.ts               # Sponsored tx relayer (sender privacy)
│   ├── src/e2e-test.ts              # Full pipeline: compile, prove, deploy, verify
│   ├── src/e2e-compliance-test.ts   # Compliance E2E: dual proofs, ECDH encryption
│   ├── src/compliance-utils.ts      # Credential leaf, nullifier, Merkle tree builder
│   ├── src/proof-converter.ts       # snarkjs JSON to Sui arkworks bytes
│   ├── src/test-converter.ts        # 109 converter tests
│   ├── src/test-compliance-utils.ts # 67 compliance utility tests
│   ├── src/fuzz-tests.ts            # Property-based fuzz tests (fast-check)
│   ├── src/seed-credential-tree.ts  # Credential tree seeding for testnet
│   └── src/deploy.ts                # Contract deployment helper
└── docs/
    ├── architecture.md              # Full architecture description
    ├── threat-model.md              # STRIDE threat model (37 threats, 30 controls)
    ├── FUTURE_IMPROVEMENTS.md       # Upgrade roadmap with implementation status
    ├── SPEC.md                      # Protocol specification
    ├── loop5-audit-report.md        # Loop 5: 11-agent comprehensive audit
    ├── tier3-audit-report.md        # Tier 3 compliance audit (10 agents)
    ├── privacy-red-team-report.md   # Privacy red team (15 findings)
    ├── zk-vulnerability-research.md # ZK vulnerability classes research
    ├── veil-architecture-report.html # Print-ready HTML report
    ├── demo-showcase.html           # Demo guide with screenshots
    ├── protocol-flow.html           # Interactive protocol flow diagram
    └── c4-*.html                    # Interactive C4 diagrams
```

## Novel Contributions

1. **Cumulative spending proofs** -- first implementation on any chain
2. **UTXO commitment consumption** -- prevents parallel chain attacks
3. **Poseidon(4) identity-bound commitments** -- commitments tied to userSecret
4. **Note-based nullifiers** -- multiple transfers per epoch (not one)
5. **Standard deposit denominations** -- resists amount correlation analysis
6. **5-loop iterative security audit** with 11 specialized agents (final loop)
7. **Dual-proof compliant transfers** -- transfer proof + compliance proof verified atomically on-chain
8. **Epoch-scoped credential nullifiers** -- prove KYC once per epoch without linking epochs
9. **ZK withdrawal with partial withdrawal** -- users exit pool without admin via Groth16 proof (recipient-bound, front-run resistant, change commitment for remaining balance)
10. **Depth-20 Poseidon Merkle accumulator** -- commitment root on-chain, anonymity set = all commitments ever inserted, timelocked root updates
11. **N-of-M multi-sig governance** -- opt-in signer approval for admin operations (freeze/unfreeze), preventing unilateral admin actions

## Sender Privacy (Relayer)

Veil hides transaction **amounts** via ZK proofs, but the sender address is still visible on-chain by default. The relayer pattern solves this by submitting transactions on behalf of users.

### How It Works

Sui natively supports **sponsored transactions** where one address pays gas for another's transaction. Veil leverages this:

```
User (browser)                          Relayer (server)                    Sui Network
     |                                       |                                  |
     |-- 1. Build TransactionKind ---------->|                                  |
     |   (Move calls, no gas info)           |                                  |
     |                                       |-- 2. Add gas payment ----------->|
     |<- 3. Return full TX bytes ------------|   (relayer's coin)               |
     |                                       |                                  |
     |-- 4. Sign TX data (wallet) --------->|                                  |
     |                                       |-- 5. Co-sign + submit ---------> |
     |                                       |                                  |
     |<- 6. Digest -------------------------|<-- 7. Confirm -------------------|
```

On-chain, the transaction shows:
- **sender** = user address (required for Move-level authorization)
- **gas payer** = relayer address (the network-visible submitter)

This means observers scanning the network see the relayer's address, not individual users. Combined with multiple users sharing the same relayer, this provides a strong anonymity set.

### Running the Relayer

```bash
# Demo mode (local, shows the full flow)
cd scripts && bun run relayer:demo

# Server mode (HTTP API for frontend integration)
cd scripts && bun run relayer
# or with custom port:
bun run src/relayer.ts serve --port 4000
```

### Frontend Integration

The frontend provides `useSponsoredTransaction` hook and `submitViaRelayer` utility:

```typescript
import { useSponsoredTransaction } from "@/hooks/useSponsoredTransaction";

function PrivateTransfer() {
  const { execute, step, isPending } = useSponsoredTransaction();

  const handleTransfer = () => execute((tx) => {
    tx.moveCall({
      target: `${PACKAGE_ID}::pool::shielded_transfer`,
      arguments: [/* ... */],
    });
  });
}
```

### Trust Model

| Aspect | Guarantee |
|--------|-----------|
| Transaction integrity | User signs the Move call -- relayer cannot alter it |
| Gas payment | Relayer pays -- user needs no SUI balance |
| Sender privacy | Relayer's address appears on-chain, not user's |
| Trust requirement | Relayer can censor (refuse to submit) but cannot steal funds or forge transactions |
| Mitigation | Multiple independent relayers, user can fall back to direct submission |

For production, the relayer should be run by multiple independent parties with no-log policies, or replaced by a decentralized gas station network.

## Known Limitations (Documented)

- ~~Sender address visible on Sui transactions~~ **Solved: relayer pattern implemented**
- ~~KYC compliance requires identity disclosure~~ **Solved: ZK credential proof (Tier 3)**
- ~~UTXO chain traceable via transaction effects~~ **Partially solved: Merkle accumulator (depth-20 Poseidon tree) provides anonymity set for transfers; deposits still visible on-chain**
- ~~No user-initiated withdrawal~~ **Solved: ZK withdrawal circuit (withdraw.circom, 9 constraints) with partial withdrawal support (change commitment for remaining balance)**
- ~~Trusted setup uses single contributor~~ **Solved: MPC ceremony script (3 contributors + beacon)**
- Admin can drain pool via timelock withdrawal or instant emergency_withdraw when frozen
- ~~`userSecret` stored in plaintext localStorage~~ **Solved: AES-GCM encrypted localStorage**
- Sybil attack on spending limits: multiple `userSecret` values bypass per-chain threshold
- UpgradeCap not burned or multisig-controlled (pre-mainnet blocker)
- `EPOCH_DURATION_MS` hardcoded to 1 hour (testnet); must be changed for mainnet

## Track

Sui Overflow 2026 -- DeFi & Payments

## License

MIT
