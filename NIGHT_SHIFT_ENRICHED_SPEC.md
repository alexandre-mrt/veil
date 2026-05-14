# Veil — Enriched Specification

## Project
Privacy payment protocol on Sui with cumulative spending proofs and tiered KYC.

## Hackathon
- **Track:** DeFi & Payments (Sui Overflow 2026)
- **Deadline:** 2026-05-23
- **Solo submission**

## Core Innovation
Epoch-based cumulative spending proofs: users prove their total spending over a fixed period (30 days, aligned with FINMA CHF 1,000 threshold) stays under a limit — without revealing individual amounts or total.

## Tiers
- **Tier 0** (< CHF 1,000/epoch): fully anonymous, no credential needed
- **Tier 1** (>= threshold): ZK proof of valid KYC credential, identity hidden
- **Tier 2** (regulatory request): auditor decrypts via ElGamal

## Technical Decisions (from questionnaire)
- **ZK stack:** Circom circuits + snarkjs browser proving (MVP). Arkworks Rust for thesis later.
- **Token:** Custom test token (mint our own for demo)
- **Priority:** Full stack MVP (contract + circuit + frontend + tests)
- **Curve:** BN254 (Sui Groth16 curve id 1)
- **Poseidon:** light-poseidon or poseidon-ark (circom-compatible, NOT arkworks sponge)
- **Epoch:** Fixed 30-day periods, reset via deterministic genesis Poseidon(0, epoch_id, 0)
- **Proofs:** Two separate proofs per tx (transfer: 6 inputs, compliance: 4 inputs)

## Architecture

### Monorepo Structure
```
~/projects/blockchain/veil/
  contracts/         — Sui Move packages
  circuits/          — Circom circuits (.circom) + build artifacts
  prover/            — Rust proof generation library (arkworks, for thesis)
  frontend/          — Next.js + dApp-kit + snarkjs
  scripts/           — deployment, testing, key generation
```

### Circuits (Circom, BN254)
1. **transfer.circom** — cumulative spending proof
   - Public: old_commitment, new_commitment, threshold, epoch_id, nullifier, tx_hash
   - Private: cumulative_old, cumulative_new, tx_amount, randomness_old, randomness_new, user_secret
   - Constraints: ~1,250 (Poseidon + range + equality)

2. **compliance.circom** — KYC credential membership (SHOULD)
   - Public: credential_root, nullifier_hash, current_time, min_kyc_level
   - Private: credential_leaf, merkle_proof, user_secret, kyc_level, expiry
   - Constraints: ~7,200 (Poseidon + 20-level Merkle)

### Move Contract
- `veil.move` — core protocol (pool, deposit, transfer, withdraw)
- `verifier.move` — Groth16 verification wrapper with PreparedVK storage
- `registry.move` — credential Merkle root management
- `token.move` — custom test token (TreasuryCap + faucet)

### Frontend
- Next.js 14+ App Router
- @mysten/dapp-kit-react 2.x for wallet
- snarkjs for client-side Groth16 proving (Web Worker)
- Encrypted localStorage for private state

## What NOT to do
- No BLS12-381 (only BN254 for snarkjs compatibility)
- No arkworks sponge for Poseidon (incompatible with Sui)
- No Table for nullifiers (use dynamic fields)
- No trusted setup shortcuts (use Hermez Powers of Tau)
- No PII on-chain ever
- No AI/Claude mentions in commits or PR

## Security Rules (BLOCKING)
1. Range-prove BOTH old_total AND tx_amount to [0, 2^64)
2. Verify VK integrity: gamma_g2 != delta_g2
3. Never use proof bytes as identifiers
4. Domain separation in Poseidon: H(1,...) for commitments, H(2,...) for nullifiers
5. Epoch from on-chain Clock, never user-supplied
6. Freeze mechanism required for compliance
7. Nullifiers deterministic: Poseidon(user_secret, context_id)
